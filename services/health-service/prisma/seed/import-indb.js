// Imports the Indian Nutrient Databank (INDB) recipes into the shared food
// catalogue.
//
//   node prisma/seed/import-indb.js            dry run: prints what would change
//   node prisma/seed/import-indb.js --apply    writes
//
// Data: prisma/seed/indb/indb.seed.json, built by indb/extract.py from the
// INDB 2024.11 release (Anuvaad Solutions; Vijayakumar et al. 2024), used with
// permission granted 2026-10-29. Values derive mainly from ICMR-NIN IFCT 2017.
//
// Rules, in the same spirit as run.js:
//   - A row is found again by its source (`indb-2024.11:<code>`), so re-running
//     updates rather than duplicates.
//   - Otherwise a shared, unverified row with the same name is upgraded to the
//     INDB values: a sourced number beats an estimate.
//   - A verified row is never changed, and a user's own food is never touched.
//   - Rows stay verified: false. A published table is not a nutritionist
//     reading the row; that is still signoff.js, one food at a time.
//   - Past food logs keep the nutrients they were logged with (FoodLog stores a
//     snapshot), so changing a row's numbers does not rewrite history.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { buildSearchText } from '../../services/ledger/foodMatch.js';
import { compositionForFood, isGenericFoodName } from '../../services/ledger/foodComposition.js';

const data = JSON.parse(readFileSync(new URL('./indb/indb.seed.json', import.meta.url), 'utf8'));
const SOURCE_PREFIX = `indb-${data.release}:`;
const NOTE = `INDB ${data.release} (Anuvaad Solutions; Vijayakumar et al. 2024, Curr Dev Nutr 8(7):103790), ` +
  'used with permission. Values derived mainly from ICMR-NIN IFCT 2017. Standard recipe; home versions vary.';
const apply = process.argv.includes('--apply');
// Reviewed pairs: INDB code -> an existing starter row that is the same food.
const MATCHES = JSON.parse(readFileSync(new URL('./indb/seed-matches.json', import.meta.url), 'utf8'));

// "Hot tea (Garam Chai)" -> alias "garam chai"; "biryani/biriyani" stays in the
// name, which search already indexes.
function aliasesFor(name) {
  return [...name.matchAll(/\(([^()]+)\)/g)]
    .flatMap((m) => m[1].split('/'))
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a && a.length <= 80);
}

// A one-word shared row ("Pizza") is hidden from search to steer people to a
// variant, so an INDB dish with such a name is labelled as the standard recipe.
function displayName(name) {
  return isGenericFoodName(name) ? `${name}, standard recipe` : name;
}

function rowFor(food) {
  const name = displayName(food.name);
  const aliases = aliasesFor(food.name);
  const composition = compositionForFood({
    name, dietaryType: food.dietaryType, ingredients: food.ingredients,
    ingredientsEstimated: true, createdByUserId: null,
  });
  return {
    name,
    aliases,
    basis: 'as_served',
    kcal: food.kcal, proteinG: food.proteinG, carbsG: food.carbsG, fatG: food.fatG, fibreG: food.fibreG,
    ironMg: food.ironMg, magnesiumMg: food.magnesiumMg, calciumMg: food.calciumMg, zincMg: food.zincMg,
    servings: food.servings.length ? food.servings : [{ label: '100 g', grams: 100 }],
    ...composition,
    veg: composition.dietaryType === 'veg',
    nonVeg: ['egg', 'non_veg'].includes(composition.dietaryType),
    source: SOURCE_PREFIX + food.code,
    verified: false,
    reviewNote: NOTE,
    searchText: buildSearchText(name, aliases),
  };
}

function mergeServings(current, added) {
  const list = Array.isArray(current) ? [...current] : [];
  for (const s of added) {
    if (!list.some((c) => String(c.label).toLowerCase() === String(s.label).toLowerCase())) list.push(s);
  }
  return list.slice(0, 8);
}

const prisma = new PrismaClient();
try {
  const counts = { created: 0, updated: 0, upgradedEstimate: 0, verifiedUntouched: 0 };
  const diets = {};
  for (const food of data.foods) {
    const row = rowFor(food);
    diets[row.dietaryType] = (diets[row.dietaryType] || 0) + 1;
    const byName = (name) => prisma.foodItem.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, createdByUserId: null },
      orderBy: [{ id: 'asc' }],
    });
    const existing =
      await prisma.foodItem.findFirst({ where: { source: row.source, createdByUserId: null } }) ||
      (MATCHES[food.code] && await byName(MATCHES[food.code])) ||
      await byName(row.name);
    // A paired starter row keeps the name people already search by; INDB's
    // name becomes one more alias.
    if (existing && existing.name.toLowerCase() !== row.name.toLowerCase()) {
      row.aliases = [...new Set([...row.aliases, row.name.toLowerCase()])];
      row.name = existing.name;
    }
    if (existing?.verified) { counts.verifiedUntouched += 1; continue; }
    if (existing) {
      if (existing.source === row.source) counts.updated += 1;
      else counts.upgradedEstimate += 1;
      if (apply) {
        await prisma.foodItem.update({ where: { id: existing.id }, data: {
          ...row,
          // Keep aliases and portion sizes people already use; INDB's serving
          // is added alongside, never in place of them.
          aliases: [...new Set([...(existing.aliases || []), ...row.aliases])],
          servings: mergeServings(existing.servings, row.servings),
          searchText: buildSearchText(row.name, [...new Set([...(existing.aliases || []), ...row.aliases])]),
        } });
      }
      continue;
    }
    counts.created += 1;
    if (apply) await prisma.foodItem.create({ data: { ...row, createdByUserId: null } });
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry run (add --apply to write)', release: data.release, ...counts, dietaryTypes: diets }, null, 2));
} finally {
  await prisma.$disconnect();
}
