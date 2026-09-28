// Idempotent seeder for the food table.
//
//   node prisma/seed/run.js
//   DATABASE_URL=... node prisma/seed/run.js
//
// Writes the FOODS array from foods.seed.js into FoodItem. Every row lands as
// `source: 'estimate'`, `verified: false` — see the header of foods.seed.js for
// why, and for the review process that has to happen before any of it is
// treated as authoritative.
//
// Idempotent on (name, basis), matched case-insensitively, because "Rice,
// cooked (white)" and "rice, cooked (white)" are the same food and a re-run
// must not create a second one. There is no unique constraint on those columns
// in the schema, so the lookup-and-update happens here; if two people add the
// same food by hand the seeder merges them rather than failing.
//
// Two rows this seeder will not touch, both deliberate:
//
//   createdByUserId set  - a food a user added by hand. Matched on
//     (name, basis) only, so a user's own entry would be found and rewritten.
//   verified             - a row a nutritionist signed off. Overwriting the
//     numbers while preserving verified: true leaves a row that claims to be
//     authoritative and holds provisional estimates.
//
// Both are asserted in test/seedSafety.test.js, because the failure mode is
// silent: the seed reports success either way.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { FOODS } from './foods.seed.js';

const prisma = new PrismaClient();

const norm = (s) => s.trim().toLowerCase();

async function seed() {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const food of FOODS) {
    const data = {
      aliases: food.aliases || [],
      basis: food.basis,
      kcal: food.kcal,
      proteinG: food.proteinG,
      carbsG: food.carbsG,
      fatG: food.fatG,
      fibreG: food.fibreG,
      ironMg: food.ironMg ?? null,
      magnesiumMg: food.magnesiumMg ?? null,
      calciumMg: food.calciumMg ?? null,
      zincMg: food.zincMg ?? null,
      servings: food.servings ?? null,
      veg: food.veg !== false,
      nonVeg: food.nonVeg === true,
      // A user's own food is never overwritten by a re-seed, so a seeded row
      // only matches rows with createdByUserId null.
      source: 'estimate',
      verified: false,
    };

    // Only rows this seeder owns are eligible: a food a user added by hand
    // carries createdByUserId, and it must never be touched.
    //
    // The filter belongs in the WHERE clause, not in an orderBy. Sorting
    // createdByUserId nulls-first only helps when a seeded row with the same
    // name already exists; when it does not, the query still matched the
    // user's own row and the update below rewrote it. One user naming a food
    // "Rice, cooked (white)" would have their entry replaced by the seeder's
    // estimates on the next run.
    const existing = await prisma.foodItem.findFirst({
      where: {
        name: { equals: food.name, mode: 'insensitive' },
        basis: food.basis,
        createdByUserId: null,
      },
      orderBy: [{ id: 'asc' }],
    });

    if (existing) {
      if (existing.verified) {
        // A row a nutritionist has signed off is left completely alone.
        //
        // Preserving just the verified flag, as this did before, was worse than
        // not running the seeder: `...data` still overwrote kcal, protein and
        // the rest with the provisional estimates while `verified: true` kept
        // asserting the numbers were checked. The row claimed to be
        // authoritative and held unverified figures. Sign-off is only
        // meaningful if nothing can rewrite the values underneath it - the
        // sign-off script is the only thing allowed to change a verified row.
        skipped += 1;
        continue;
      }
      await prisma.foodItem.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.foodItem.create({ data: { name: food.name, ...data } });
      created += 1;
    }
  }

  console.log(
    `foods seeded: ${created} created, ${updated} updated, ${skipped} verified-and-untouched, ${FOODS.length} total`,
  );
  console.log('all rows are source=estimate, verified=false pending nutritionist sign-off');
}

seed()
  .catch((err) => {
    console.error('food seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
