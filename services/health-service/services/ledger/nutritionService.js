// Nutrition: search the food table, log what was eaten, aggregate a day,
// and repeat a meal from a saved one.
//
// Two invariants run through the whole file:
//
//  1. A FoodLog stores a SNAPSHOT of the food's nutrient values in `nutrients`,
//     copied at log time, not a live join. Editing a food's numbers must never
//     rewrite what someone ate last Tuesday, and a deleted FoodItem must not
//     erase the day. That is why FoodItem is `onDelete: SetNull` and why the
//     snapshot is the source of truth for every total below.
//
//  2. Every query is scoped by userId. A log is private health data; there is
//     no code path in here that returns another user's food, and the userId is
//     taken from the caller's context, never from user input.
import {
  MEAL_SLOTS,
  FOOD_LOG_SOURCES,
  DEFAULT_FOOD_LOG_SOURCE,
  DECIMAL_PLACES,
  roundTo,
} from './constants.js';

const GRAMS_MAX = 5000;
const SERVINGS_MAX = 50;

// Nutrients that make up a log's snapshot. Kept as one list because the
// snapshot, the day total, and the delta-from-target all have to agree on
// which fields exist; a macro silently missing from one of the three is how a
// total ends up 40 kcal short of the sum of its parts.
const SNAPSHOT_FIELDS = [
  'kcal',
  'proteinG',
  'carbsG',
  'fatG',
  'fibreG',
  'ironMg',
  'magnesiumMg',
  'calciumMg',
  'zincMg',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Grams is authoritative when both are sent. Someone correcting a portion by
// hand means the grams; a client that sends a stale servings count alongside a
// fresh gram weight must not have the grams silently overwritten by the
// serving maths.
function toGrams(grams, servings, food) {
  if (grams != null && Number(grams) > 0) return Number(grams);
  if (servings != null && servings > 0 && food?.servings) {
    const list = Array.isArray(food.servings) ? food.servings : [];
    const match = list.find((s) => Number(s.grams) > 0);
    if (match) return Number(servings) * Number(match.grams);
  }
  return 0;
}

/**
 * Scale a food's per-100 g values to a portion.
 * Returns plain numbers, rounded once here so the stored snapshot and any
 * later recomputation of a total see identical values.
 */
export function computePortion(food, grams) {
  const factor = grams / 100;
  const out = {};
  for (const field of SNAPSHOT_FIELDS) {
    const value = food[field];
    out[field] = value == null ? null : roundTo(num(value) * factor, DECIMAL_PLACES.nutrients);
  }
  return out;
}

export function emptyTotals() {
  const totals = {};
  for (const f of SNAPSHOT_FIELDS) totals[f] = 0;
  return totals;
}

function addInto(target, source) {
  for (const field of SNAPSHOT_FIELDS) {
    target[field] = roundTo(num(target[field]) + num(source?.[field]), DECIMAL_PLACES.nutrients);
  }
  return target;
}

/**
 * Search foods for the picker.
 *
 * Unverified rows are excluded unless the caller explicitly asks. The seeded
 * catalogue is all `verified: false` (see prisma/seed/foods.seed.js), so the
 * default would otherwise return an empty list — which is exactly the state we
 * want to be visible rather than papered over with numbers nobody has checked.
 * The Flutter app sets includeUnverified so the food log still works.
 */
export async function searchFoods(prisma, userId, { query, includeUnverified = false, limit = 25 } = {}) {
  const q = (query || '').trim();
  if (!q) return [];

  const rows = await prisma.foodItem.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { aliases: { has: q.toLowerCase() } },
      ],
  // A user's own foods are always available to them regardless of the
  // verification flag; the flag is about our catalogue, not their data.
      AND: includeUnverified ? [] : [{ OR: [{ verified: true }, { createdByUserId: userId }] }],
    },
    orderBy: [{ name: 'asc' }],
    take: Math.min(Number(limit) || 25, 100),
  });

  return rows;
}

/**
 * Log one food for one meal on one local date.
 *
 * Requires nutrition consent. The snapshot is written here, at log time, and
 * is never recomputed.
 */
export async function logFood(prisma, { userId, localDate, slot, foodItemId, grams, servings, servingLabel, source = DEFAULT_FOOD_LOG_SOURCE, photoCorrections = 0 }) {
  if (!MEAL_SLOTS.includes(slot)) {
    throw badRequest(`slot must be one of: ${MEAL_SLOTS.join(', ')}`);
  }
  // Checked here rather than left to Prisma. An unknown source is a client bug,
  // and a Prisma enum violation arrives as an opaque 500 that looks like a
  // server fault instead of something the caller can fix.
  if (!FOOD_LOG_SOURCES.includes(source)) {
    throw badRequest(`source must be one of: ${FOOD_LOG_SOURCES.join(', ')}`);
  }

  const food = await prisma.foodItem.findUnique({ where: { id: Number(foodItemId) } });
  if (!food) throw notFound('That food is not in the catalogue');

  // A user may log their own custom food, and never someone else's.
  if (food.createdByUserId != null && food.createdByUserId !== userId) {
    throw notFound('That food is not in the catalogue');
  }

  const resolvedGrams = toGrams(grams, servings, food);
  if (!(resolvedGrams > 0)) {
    throw badRequest('Provide grams, or a serving count for a food that has servings');
  }
  if (resolvedGrams > GRAMS_MAX) {
    throw badRequest(`That is over ${GRAMS_MAX} g, which is more food than one meal`);
  }

  const nutrients = computePortion(food, resolvedGrams);

  return prisma.foodLog.create({
    data: {
      userId,
      localDate,
      slot,
      foodItemId: food.id,
      grams: roundTo(resolvedGrams, DECIMAL_PLACES.grams),
      servingLabel: servingLabel || null,
      servings: servings != null ? Number(servings) : null,
      nutrients,
      source,
      photoCorrections: Number(photoCorrections) || 0,
      // Copied onto the row so a day's log can be rendered without joining
      // FoodItem, and so the name survives the food being deleted.
      name: food.name,
      nonVeg: food.nonVeg,
    },
  });
}

/**
 * Totals for one local date, broken down by meal slot.
 *
 * Reads `nutrients` off each log rather than joining FoodItem, for the snapshot
 * reason above.
 */
export async function getDayTotals(prisma, userId, localDate) {
  const logs = await prisma.foodLog.findMany({
    where: { userId, localDate },
    orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
  });

  const bySlot = {};
  for (const slot of MEAL_SLOTS) {
    bySlot[slot] = { totals: emptyTotals(), count: 0 };
  }

  const day = emptyTotals();
  for (const log of logs) {
    const bucket = bySlot[log.slot] || (bySlot[log.slot] = { totals: emptyTotals(), count: 0 });
    addInto(bucket.totals, log.nutrients);
    bucket.count += 1;
    addInto(day, log.nutrients);
  }

  return { localDate, totals: day, bySlot, logCount: logs.length };
}

/**
 * Signed difference from a target: positive means under, negative means over.
 * The sign convention is stated here once because the score engine reads it and
 * an inverted meaning would quietly reward overeating.
 */
export function deltaFromTarget(totals, target) {
  const out = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (target?.[field] == null) {
      out[field] = null;
      continue;
    }
    out[field] = roundTo(num(target[field]) - num(totals[field]), DECIMAL_PLACES.nutrients);
  }
  return out;
}

/**
 * How much is left in the day, as a share of target. Capped at 0 and 1 so a
 * partial log does not render as "you have used 400% of your protein".
 */
export function progressAgainstTarget(totals, target) {
  const out = {};
  for (const field of ['kcal', 'proteinG', 'carbsG', 'fatG', 'fibreG']) {
    const goal = num(target?.[field]);
    const got = num(totals?.[field]);
    out[field] = goal > 0 ? Math.max(0, Math.min(1, roundTo(got / goal, 4))) : null;
  }
  return out;
}

export async function deleteLog(prisma, userId, logId) {
  const existing = await prisma.foodLog.findFirst({ where: { id: Number(logId), userId } });
  if (!existing) throw notFound('No such food log');
  return prisma.foodLog.delete({ where: { id: existing.id } });
}

/**
 * Save a meal so it can be repeated in one tap. Only the user's own logs are
 * read, so a saved meal can never be assembled from someone else's data.
 */
export async function saveMeal(prisma, { userId, name, slot, localDate }) {
  if (!name || !name.trim()) throw badRequest('Give the meal a name');
  if (!MEAL_SLOTS.includes(slot)) {
    throw badRequest(`slot must be one of: ${MEAL_SLOTS.join(', ')}`);
  }

  const logs = await prisma.foodLog.findMany({
    where: { userId, localDate, slot },
    orderBy: { createdAt: 'asc' },
  });
  if (!logs.length) throw badRequest('There is nothing logged in that meal to save');

  return prisma.savedMeal.create({
    data: {
      userId,
      name: name.trim().slice(0, 80),
      slot,
      lines: {
        // `order` is the index of the log within the meal, so a saved meal
        // renders in the order it was eaten rather than in whatever order the
        // database happens to return.
        create: logs.map((log, i) => ({
          order: i,
          foodItemId: log.foodItemId,
          grams: log.grams,
          servingLabel: log.servingLabel,
          // The same snapshot rule as FoodLog: a saved meal keeps the numbers
          // as they were when it was saved, so editing a food later does not
          // silently change what "my usual breakfast" means.
          nutrients: log.nutrients,
          name: log.name,
          nonVeg: log.nonVeg,
        })),
      },
    },
    include: { lines: true },
  });
}

/**
 * Repeat a saved meal onto a date. Lines whose FoodItem has since been deleted
 * are skipped rather than failing the whole repeat: a saved paratha is still
 * worth logging even if the cheese went.
 */
export async function logSavedMeal(prisma, { userId, savedMealId, localDate, slot }) {
  // `include: { lines: true }` is load-bearing, not a convenience. Everything
  // below iterates meal.lines; the include was missing, so a real Prisma client
  // returned a meal with no `lines` property at all and this threw on the first
  // iteration. The tests passed because the mock returned lines regardless of
  // what was asked for - a mock that is more generous than the database is worse
  // than no mock, because it hides exactly this class of bug.
  const meal = await prisma.savedMeal.findFirst({
    where: { id: Number(savedMealId), userId },
    include: { lines: { orderBy: { order: 'asc' } } },
  });
  if (!meal) throw notFound('No such saved meal');

  const targetSlot = slot || meal.slot;
  if (!MEAL_SLOTS.includes(targetSlot)) {
    throw badRequest(`slot must be one of: ${MEAL_SLOTS.join(', ')}`);
  }

  const live = await prisma.foodItem.findMany({
    where: { id: { in: meal.lines.map((l) => l.foodItemId).filter((id) => id != null) } },
    select: { id: true },
  });
  const liveIds = new Set(live.map((f) => f.id));

  const skipped = [];
  const created = [];
  for (const line of meal.lines) {
    if (line.foodItemId != null && !liveIds.has(line.foodItemId)) {
      skipped.push(line.name || 'a food no longer in the catalogue');
      continue;
    }
    created.push({
      userId,
      foodItemId: line.foodItemId,
      localDate,
      slot: targetSlot,
      grams: line.grams,
      servingLabel: line.servingLabel,
      nutrients: line.nutrients,
      source: 'saved_meal',
      name: line.name,
      nonVeg: line.nonVeg,
    });
  }

  if (!created.length) throw badRequest('None of that meal\'s foods are available any more');

  const logs = await prisma.foodLog.createMany({ data: created });
  return { logged: created.length, skipped, meal: meal.name };
}

export async function listSavedMeals(prisma, userId) {
  return prisma.savedMeal.findMany({
    where: { userId },
    include: { lines: true },
    orderBy: { updatedAt: 'desc' },
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}
