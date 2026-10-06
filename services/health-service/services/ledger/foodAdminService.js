// The ONE sanctioned FoodItem write in this service.
//
// foodRequestService exists to keep "a request is not a food" true: nothing
// turns a user's free text into a nutrient value, and the catalogue grows by
// someone who can source a number. This module is where that "someone" works.
// A gobhi reviewer is not a user at 11pm - they have read the queue, they are
// adding a named dish the queue is asking for, and they bring a source. The
// `source` and `verified` fields were designed for exactly this hand point,
// and every row created here records both.
//
// The line between this module and foodRequestService is the line the whole
// service draws: a FoodRequest is input, a FoodItem is data, and only a person
// with a gobhi role passes between them. That crossing is resolved here - a
// created food closes the pending requests for its name, which is what turns
// the demand queue into a roadmap with receipts.

const NAME_MAX = 80;
const ALIAS_MAX = 12;
const PROVENANCE_MAX = 80;
const NOTE_MAX = 500;

export const FOOD_SOURCES = ['estimate', 'ifct2017', 'usda', 'label-scan', 'user-entered'];
export const FOOD_BASES = ['raw', 'cooked', 'as_served'];
const REQUIRED_NUMBERS = ['kcal', 'proteinG', 'carbsG', 'fatG', 'fibreG'];

import { buildSearchText } from './foodMatch.js';

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

function clamp(value, max) {
  const trimmed = String(value ?? '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Create a catalogue food from sourced values and close the pending requests
 * for its name.
 *
 * Returns `{ food, created, resolvedRequests }`. The food row matches the
 * seeded shape (per 100 g, `basis` describing the state the numbers are in);
 * `source` is required and defaults to 'estimate' - claiming 'ifct2017'
 * without the NIN value in hand is a provenance lie, and this is where the
 * lie would be made.
 */
export async function createFood(
  prisma,
  {
    name,
    aliases,
    basis,
    kcal,
    proteinG,
    carbsG,
    fatG,
    fibreG,
    ironMg,
    magnesiumMg,
    calciumMg,
    zincMg,
    servings,
    nonVeg = false,
    veg,
    source,
    verified = false,
    verifiedBy,
    reviewNote,
  },
) {
  const cleanName = clamp(name, NAME_MAX);
  if (!cleanName) throw badRequest('Name the food', 'NAME_REQUIRED');

  const cleanAliases = (aliases || [])
    .map((a) => clamp(a, 80))
    .filter(Boolean)
    .slice(0, ALIAS_MAX);

  // The reviewer is adding what the queue keeps asking for; if a row already
  // exists under another spelling, the right fix is an alias, not a duplicate.
  const exists = await prisma.foodItem.findFirst({
    where: {
      name: { equals: cleanName, mode: 'insensitive' },
      createdByUserId: null,
    },
    select: { id: true, name: true },
  });
  if (exists) {
    throw Object.assign(new Error('We already have that food'), {
      status: 409,
      code: 'FOOD_EXISTS',
      foods: [exists],
    });
  }

  // Every required number must be positive. A katori of "estimate 0 kcal" is
  // the exact fabricated-number failure this catalogue exists to avoid.
  const numbers = { kcal, proteinG, carbsG, fatG, fibreG };
  const missing = REQUIRED_NUMBERS.filter((field) => !(num(numbers[field]) > 0));
  if (missing.length) {
    throw badRequest(`Per-100 g numbers required: ${missing.join(', ')}`, 'NUMBERS_REQUIRED');
  }

  const cleanSource = FOOD_SOURCES.includes(source) ? source : 'estimate';
  const cleanVerified = verified === true;
  const cleanBasis = FOOD_BASES.includes(basis) ? basis : 'cooked';

  const cleanServings =
    Array.isArray(servings) && servings.length
      ? servings
          .map((s) => ({
            label: clamp(s?.label, 40),
            grams: num(s?.grams),
          }))
          .filter((s) => s.label && s.grams > 0)
          .slice(0, 8)
      : null;

  const food = await prisma.foodItem.create({
    data: {
      name: cleanName,
      aliases: cleanAliases,
      basis: cleanBasis,
      kcal: num(kcal),
      proteinG: num(proteinG),
      carbsG: num(carbsG),
      fatG: num(fatG),
      fibreG: num(fibreG),
      ironMg: num(ironMg),
      magnesiumMg: num(magnesiumMg),
      calciumMg: num(calciumMg),
      zincMg: num(zincMg),
      servings: cleanServings,
      veg: veg !== false && nonVeg !== true,
      nonVeg: nonVeg === true,
      createdByUserId: null,
      source: cleanSource,
      verified: cleanVerified,
      verifiedBy: cleanVerified ? clamp(verifiedBy, PROVENANCE_MAX) || 'gobhi' : null,
      verifiedAt: cleanVerified ? new Date() : null,
      reviewNote: cleanVerified ? clamp(reviewNote, NOTE_MAX) : null,
      searchText: buildSearchText(cleanName, cleanAliases),
    },
  });

  // A food the queue was asking for is no longer a request. This is the one
  // resolution that happens automatically, and it is exact: the same
  // case-insensitive name the queue collapsed on. Nothing is inferred - a row
  // named exactly this way, only.
  const matched = await prisma.foodRequest.updateMany({
    where: { name: { equals: cleanName, mode: 'insensitive' }, status: 'pending' },
    data: {
      status: 'resolved',
      resolvedAt: new Date(),
      reviewNote: `Catalogue now carries '${cleanName}'`,
    },
  });

  return { food, created: true, resolvedRequests: matched.count };
}