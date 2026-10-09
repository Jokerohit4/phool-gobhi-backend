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

import { rankFoods } from './foodMatch.js';
import { isIsoDay } from './isoDay.js';

const GRAMS_MAX = 5000;
const SERVINGS_MAX = 50;
// A ceiling on a hand-entered calorie figure, same spirit as GRAMS_MAX: a guard
// against a fat-fingered extra digit, not a judgement about the meal. Well above
// any single food, so it only ever catches a typo.
const KCAL_MAX_QUICK = 5000;

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
 * Two stages, and the split is deliberate.
 *
 * SQL narrows, JS ranks. The database does what only it can do cheaply -
 * substring matching over a few hundred rows - and the ranking happens in Node
 * because the ordering is a judgement about which name is more likely to be the
 * one that was typed. That judgement cannot be expressed as an `orderBy`.
 *
 * There is no `take`. The previous `take: 25` was truncating an ALPHABETICAL
 * list, which is the worst possible way to lose a result: search "chicken" and
 * the intended row is simply absent if it sorts past position 25, with nothing
 * in the response to say so. Ranking first means any cut happens on relevance.
 * The candidate set is bounded by the substring prefilter, so an unbounded
 * `findMany` is not an unbounded result - a 2-character query still matches a
 * slice of the catalogue, which is why scoreMatch refuses to rank substrings
 * that short.
 *
 * Unverified rows are excluded unless the caller explicitly asks. The seeded
 * catalogue is all `verified: false` (see prisma/seed/foods.seed.js), so the
 * default would otherwise return an empty list â€” which is exactly the state we
 * want to be visible rather than papered over with numbers nobody has checked.
 * The Flutter app sets includeUnverified so the food log still works.
 */
export async function searchFoods(prisma, userId, { query, includeUnverified = false } = {}) {
  const q = (query || '').trim();
  if (!q) return [];

  // Three branches, and the reason for each:
  //
  //   searchText - the haystack of name + every alias. This is the branch that
  //                makes an alias match PARTIALLY: `has` on a String[] is exact
  //                element only, so without this "omlet" and "dosa with" cannot
  //                find rows however they are spelled or aliased.
  //   name       - a user-created food written before searchText existed has
  //                nothing in that column, and this branch still finds it. Also
  //                the branch the name index can serve.
  //   aliases    - exact element match, kept as a cheap third net rather than
  //                for correctness. It is redundant against searchText on any
  //                row written by the current seeder, and deliberately so: it
  //                catches an alias that somehow is not in the haystack, which
  //                is cheaper to leave in than to prove cannot happen.
  //
  // q is lowercased once for searchText and aliases because the seeder writes
  // them lowercased; `mode: 'insensitive'` makes that redundant on searchText but
  // not on the array, which has no mode. Both together so a hand-inserted
  // capitalised alias still matches.
  const needle = q.toLowerCase();
  const rows = await prisma.foodItem.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { searchText: { contains: needle, mode: 'insensitive' } },
        { aliases: { has: needle } },
      ],
      // A user's own foods are always available to them regardless of the
      // verification flag; the flag is about our catalogue, not their data.
      AND: includeUnverified ? [] : [{ OR: [{ verified: true }, { createdByUserId: userId }] }],
    },
    orderBy: [{ name: 'asc' }],
  });

  return rankFoods(rows, q);
}

/**
 * Log one food for one meal on one local date.
 *
 * Requires nutrition consent. The snapshot is written here, at log time, and
 * is never recomputed.
 *
 * `photo` is the provenance of a photo-sourced log: `{ path, proposedName,
 * confidence, model }`. Every field is optional and all are written only when
 * `source === 'photo_confirmed'`, so a search or saved-meal log is unaffected -
 * which is the point of grouping them behind one argument instead of four more
 * parameters that every caller would have to know to leave undefined.
 */
export async function logFood(prisma, { userId, localDate, slot, foodItemId, grams, servings, servingLabel, source = DEFAULT_FOOD_LOG_SOURCE, photoCorrections = 0, photo = null }) {
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

  // Photo provenance is only meaningful for a photo-sourced log. Gating on the
  // source rather than on the presence of `photo` keeps a caller from attaching
  // a photo to a row that claims to have come from a search, which would make
  // the correction metric - "of the lines that came from a photo, how many were
  // corrected" - quietly wrong.
  const photoFields =
    source === 'photo_confirmed'
      ? {
          photoPath: photo?.path || null,
          photoProposedName: photo?.proposedName || null,
          photoConfidence: Number.isFinite(Number(photo?.confidence))
            ? Number(photo.confidence)
            : null,
          photoModel: photo?.model || null,
        }
      : {};

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
      ...photoFields,
      // Copied onto the row so a day's log can be rendered without joining
      // FoodItem, and so the name survives the food being deleted.
      name: food.name,
      nonVeg: food.nonVeg,
    },
  });
}

/**
 * Log a food that is NOT in the catalogue, as present-but-unknown.
 *
 * The one writer for source `photo_unmatched`. It exists for a single,
 * deliberate case: the user confirms a photo line this catalogue cannot name.
 * The line stays part of their day - it was on the plate - but it must not be
 * invented into numbers. The snapshot is a sentinel, `{ "unknown": true }`,
 * which getDayTotals counts and refuses to sum (a fabricated zero would make
 * the day's total quietly short in exactly the way this ledger exists to
 * prevent).
 *
 * `picture` is kept even though there is no food to attach it to, because it is
 * what the reviewer and the user can both see: "that yellow thing, you logged
 * it on the 14th" is a photo, not a nutrient row.
 */
export async function logUnknownFood(
  prisma,
  { userId, localDate, slot, grams, name, servingLabel = null, nonVeg = false, photoCorrections = 0, photo = null },
) {
  if (!MEAL_SLOTS.includes(slot)) {
    throw badRequest(`slot must be one of: ${MEAL_SLOTS.join(', ')}`);
  }

  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!cleanName) {
    throw badRequest('Name the food that was on the plate', 'NAME_REQUIRED');
  }

  const resolvedGrams = Number(grams);
  if (!(resolvedGrams > 0)) {
    throw badRequest('Provide grams for the item');
  }
  if (resolvedGrams > GRAMS_MAX) {
    throw badRequest(`That is over ${GRAMS_MAX} g, which is more food than one meal`);
  }

  // Same provenance gating as logFood: the photo fields only belong on rows
  // that truly came from a photo.
  const photoFields =
    photo
      ? {
          photoPath: photo?.path || null,
          photoProposedName: photo?.proposedName || null,
          photoConfidence: Number.isFinite(Number(photo?.confidence))
            ? Number(photo.confidence)
            : null,
          photoModel: photo?.model || null,
        }
      : {};

  return prisma.foodLog.create({
    data: {
      userId,
      localDate,
      slot,
      foodItemId: null,
      grams: roundTo(resolvedGrams, DECIMAL_PLACES.grams),
      servingLabel: servingLabel || null,
      servings: null,
      // The sentinel. Never a null and never a zero-filled object, so a totals
      // read can tell "on the plate, unmeasured" from "missing data" and from
      // "ate nothing at all".
      nutrients: { unknown: true },
      source: 'photo_unmatched',
      photoCorrections: Number(photoCorrections) || 0,
      ...photoFields,
      name: cleanName,
      nonVeg: nonVeg === true,
    },
  });
}

export function isUnknownSnapshot(nutrients) {
  return nutrients != null && nutrients.unknown === true;
}

/**
 * Log a food the user typed themselves, with an approximate calorie figure.
 *
 * The third writer, after [logFood] (catalogue) and [logUnknownFood]
 * (photo_unmatched). It covers the case those two cannot: a food the catalogue
 * does not carry that the user still knows the energy of - "a plate of mom's
 * rajma, about 350". [logUnknownFood] is present-but-unmeasured and adds
 * nothing to the day; this row is a deliberate estimate and DOES count, because
 * a number the user chose is more honest than a hole in the day.
 *
 * The name and the calories are both required and the calories must be
 * positive: this is an explicit estimate, never an implicit zero. The macro
 * fields are left at 0 rather than back-filled - the user gave one number, and
 * splitting it into protein/carbs/fat would be inventing three numbers from
 * one. Written with source `custom`, so it can be told apart from a catalogue
 * log when the catalogue catches up.
 */
export async function logQuickFood(
  prisma,
  { userId, localDate, slot, name, kcal, grams = 100, servingLabel = null },
) {
  if (!MEAL_SLOTS.includes(slot)) {
    throw badRequest(`slot must be one of: ${MEAL_SLOTS.join(', ')}`);
  }

  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!cleanName) {
    throw badRequest('Name the food you ate', 'NAME_REQUIRED');
  }

  const calories = Number(kcal);
  if (!(calories > 0)) {
    throw badRequest('Enter the approximate calories', 'KCAL_REQUIRED');
  }
  if (calories > KCAL_MAX_QUICK) {
    throw badRequest(`That is over ${KCAL_MAX_QUICK} kcal for one food`);
  }

  // Grams is the record of the portion, not the basis of the number: the user
  // gave the energy for the whole thing, so the snapshot is that figure and not
  // a per-100 g scaling of it.
  const resolvedGrams = Number(grams);
  if (!(resolvedGrams > 0)) {
    throw badRequest('Provide grams for the item');
  }
  if (resolvedGrams > GRAMS_MAX) {
    throw badRequest(`That is over ${GRAMS_MAX} g, which is more food than one meal`);
  }

  const nutrients = emptyTotals();
  nutrients.kcal = roundTo(calories, DECIMAL_PLACES.nutrients);

  return prisma.foodLog.create({
    data: {
      userId,
      localDate,
      slot,
      foodItemId: null,
      grams: roundTo(resolvedGrams, DECIMAL_PLACES.grams),
      servingLabel: servingLabel || null,
      servings: null,
      nutrients,
      source: 'custom',
      photoCorrections: 0,
      name: cleanName,
      nonVeg: false,
    },
  });
}

/**
 * Totals for one local date, broken down by meal slot.
 *
 * Reads `nutrients` off each log rather than joining FoodItem, for the snapshot
 * reason above. A photo_unmatched row is counted (it is a real entry in the
 * meal) but never added to any sum - see isUnknownSnapshot.
 *
 * The rows ride along as `logs`. They were already in memory - the loop below
 * is standing in them - and the food card needs both halves: a day cannot be
 * listed under its meals from a count, and a count shown above rows from a
 * different read can disagree with them by one entry. One read also costs no
 * extra round trip, which matters because a day load already spends four, and
 * a response with no `logs` key at all parses as an empty list rather than as
 * a failure, so an older service degrades to "counts without rows".
 */
export async function getDayTotals(prisma, userId, localDate) {
  const logs = await prisma.foodLog.findMany({
    where: { userId, localDate },
    orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
  });

  const bySlot = {};
  for (const slot of MEAL_SLOTS) {
    bySlot[slot] = { totals: emptyTotals(), count: 0, pendingCount: 0 };
  }

  const day = emptyTotals();
  let pendingCount = 0;
  for (const log of logs) {
    const bucket = bySlot[log.slot] || (bySlot[log.slot] = { totals: emptyTotals(), count: 0, pendingCount: 0 });
    bucket.count += 1;
    if (isUnknownSnapshot(log.nutrients)) {
      bucket.pendingCount += 1;
      pendingCount += 1;
      continue;
    }
    addInto(bucket.totals, log.nutrients);
    addInto(day, log.nutrients);
  }

  return { localDate, totals: day, bySlot, logCount: logs.length, pendingCount, logs };
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
 * Correct one logged food: its size, the label it was filed under, or the meal
 * it sits in.
 *
 * The snapshot rule has exactly one exception and it is worth spelling out,
 * because this looks like a violation of it. When the PORTION changes the
 * nutrients are recomputed from the food's own per-100 g numbers - but that is
 * the user correcting their own entry against numbers that have not moved, not
 * a catalogue edit reaching back into a past day. What the rule still forbids,
 * and what no code path here can do, is an admin editing a FoodItem and having
 * it rewrite what someone ate last Tuesday.
 *
 * A row with no food behind it - a photo line this catalogue could not name, or
 * a food since deleted (FoodItem is onDelete: SetNull) - cannot be re-portioned,
 * because there is nothing left to scale. Its meal and label can still move, so
 * the refusal says which part is impossible rather than refusing the whole edit.
 *
 * Returns the row, the same shape POST /food-logs and DELETE /food-logs/:id
 * already return, so a caller has one thing to parse.
 */
export async function updateLog(prisma, userId, logId, { grams, servings, servingLabel, slot } = {}) {
  const existing = await prisma.foodLog.findFirst({
    where: { id: Number(logId), userId },
  });
  if (!existing) throw notFound('No such food log');

  const changes = {};

  if (slot != null) {
    if (!MEAL_SLOTS.includes(slot)) {
      throw badRequest(`slot must be one of: ${MEAL_SLOTS.join(', ')}`);
    }
    changes.slot = slot;
  }

  const wantsPortion = grams != null || servings != null;
  const wantsLabel = servingLabel !== undefined;

  if (wantsPortion) {
    const food =
      existing.foodItemId != null
        ? await prisma.foodItem.findUnique({ where: { id: existing.foodItemId } })
        : null;
    if (!food) {
      throw badRequest(
        isUnknownSnapshot(existing.nutrients)
          ? 'That entry has no nutrition attached, so its size cannot be changed - remove it and log it again'
          : 'That food is no longer in the list, so its size cannot be changed - remove it and log it again',
        'NO_FOOD_TO_SCALE',
      );
    }
    // A user may resize their own custom food, and never somebody else's -
    // the same rule logFood applies, checked again here for the same reason:
    // this is a second path to the catalogue.
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

    changes.grams = roundTo(resolvedGrams, DECIMAL_PLACES.grams);
    changes.servings = servings != null ? Number(servings) : null;
    changes.nutrients = computePortion(food, resolvedGrams);
    // The old label described the old portion - "2 rotis" sitting on top of
    // 150 g is a lie the moment the number moves. Cleared unless the caller
    // supplies the one that matches now; an absent label falls back to the
    // gram weight on the client.
    if (!wantsLabel) changes.servingLabel = null;

    // The photo feature's launch metric is "how many photo-derived rows did the
    // user have to correct", and the confirm-time counter cannot see an edit
    // made afterwards. A resize of a photo row is exactly that correction.
    if (existing.photoPath != null) {
      changes.photoCorrections = Number(existing.photoCorrections) + 1;
    }
  }

  if (wantsLabel) changes.servingLabel = servingLabel || null;

  if (Object.keys(changes).length === 0) throw badRequest('Nothing to change');

  return prisma.foodLog.update({ where: { id: existing.id }, data: changes });
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
  // The day is required and validated, unlike the search path's optional date,
  // because this write is many rows at once and there is no day for them to be
  // scoped to otherwise: an empty `localDate` still satisfies the column type,
  // so the repeat would report success while writing rows that `getDayTotals`
  // â€” which queries `where: { localDate }` â€” could never match again. The
  // client sends the device date, and this refuses to trust it blindly.
  if (!isIsoDay(localDate)) {
    throw badRequest('localDate must be YYYY-MM-DD');
  }
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

function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  if (code) err.code = code;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

export async function updateSavedMeal(prisma, { userId, id, name, slot }) {
  const meal = await prisma.savedMeal.findFirst({ where: { id: Number(id), userId } });
  if (!meal) throw notFound('Saved meal not found');
  const data = {};
  if (typeof name === 'string' && name.trim()) data.name = name.trim();
  if (slot) data.slot = slot;
  if (Object.keys(data).length) data.updatedAt = new Date();
  return prisma.savedMeal.update({ where: { id: meal.id }, data, include: { lines: true } });
}

export async function deleteSavedMeal(prisma, { userId, id }) {
  const meal = await prisma.savedMeal.findFirst({ where: { id: Number(id), userId } });
  if (!meal) throw notFound('Saved meal not found');
  await prisma.savedMeal.delete({ where: { id: meal.id } });
}

