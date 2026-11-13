import { compositionForFood, assertSpecificName } from './foodComposition.js';
import { buildSearchText } from './foodMatch.js';

const MACROS = ['proteinG', 'carbsG', 'fatG', 'fibreG'];
const MICROS = ['ironMg', 'magnesiumMg', 'calciumMg', 'zincMg'];
const clean = (value, max) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
const validNumber = (value, max) => typeof value === 'number' &&
  Number.isFinite(value) && value >= 0 && value <= max;

// Missing values are never coerced into zero. A response without usable
// nutrition is a retryable recognition failure, not a catalogue task for users.
export function normaliseFoodEstimate(value) {
  if (!value || !validNumber(value.kcal, 1000) ||
      MACROS.some((key) => !validNumber(value[key], 100))) return null;
  if (value.proteinG + value.carbsG + value.fatG > 105 ||
      value.fibreG > value.carbsG) return null;
  const servings = Array.isArray(value.servings) ? value.servings
    .map((s) => ({ label: clean(s?.label, 40), grams: s?.grams }))
    .filter((s) => s.label && validNumber(s.grams, 5000) && s.grams > 0)
    .slice(0, 8) : [];
  if (!servings.length) return null;
  return {
    kcal: value.kcal,
    ...Object.fromEntries(MACROS.map((key) => [key, value[key]])),
    ...Object.fromEntries(MICROS.map((key) => [key,
      validNumber(value[key], 10000) ? value[key] : null])),
    aliases: Array.isArray(value.aliases)
      ? [...new Set(value.aliases.map((a) => clean(a, 80)).filter(Boolean))].slice(0, 12) : [],
    basis: ['raw', 'cooked', 'as_served'].includes(value.basis) ? value.basis : 'as_served',
    servings,
  };
}

export async function ensurePhotoFood(prisma, item, { model } = {}) {
  const name = clean(item.name, 80);
  assertSpecificName(name);
  return prisma.$transaction(async (tx) => {
    // No schema migration is needed. Serialize simultaneous photographs of the
    // same dish across service instances, then recheck before inserting.
    const lock = `photo-food:${name.toLowerCase()}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const existing = await tx.foodItem.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, createdByUserId: null },
    });
    if (existing) return existing;
    const nutrition = normaliseFoodEstimate(item.nutrition);
    if (!name || !nutrition) {
      throw Object.assign(new Error('Could not read all food details. Try again.'), {
        status: 502, code: 'PROVIDER_FAILED',
      });
    }
    return tx.foodItem.create({ data: {
      name,
      ...nutrition,
      ...compositionForFood(item),
      veg: compositionForFood(item).dietaryType === 'veg',
      nonVeg: ['egg', 'non_veg'].includes(compositionForFood(item).dietaryType),
      createdByUserId: null,
      source: 'estimate',
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      reviewNote: `Auto-added from photo recognition; AI estimate (${clean(model, 120) || 'vision'}).`,
      searchText: buildSearchText(name, nutrition.aliases),
    } });
  });
}
