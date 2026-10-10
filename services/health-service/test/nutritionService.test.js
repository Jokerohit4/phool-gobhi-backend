import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  computePortion,
  deltaFromTarget,
  emptyTotals,
  getDayTotals,
  isUnknownSnapshot,
  logFood,
  logQuickFood,
  logUnknownFood,
  logSavedMeal,
  progressAgainstTarget,
  recentFoods,
  repeatDay,
  saveMeal,
  searchFoods,
  updateLog,
} from '../services/ledger/nutritionService.js';

function mockPrisma(overrides = {}) {
  return {
    foodItem: {
      findMany: async () => [],
      findUnique: async () => null,
      ...overrides.foodItem,
    },
    foodLog: {
      create: async (args) => ({ id: 1, ...args.data }),
      createMany: async (args) => ({ count: args.data.length }),
      findMany: async () => [],
      findFirst: async () => null,
      delete: async (args) => ({ id: args.where.id }),
      update: async (args) => ({ ...args.where, ...args.data }),
      ...overrides.foodLog,
    },
    savedMeal: {
      create: async (args) => ({ id: 1, ...args.data }),
      findFirst: async () => null,
      findMany: async () => [],
      ...overrides.savedMeal,
    },
    ...overrides.rest,
  };
}

const RICE = {
  id: 1,
  name: 'Rice, cooked (white)',
  aliases: ['chawal', 'bhaat'],
  basis: 'cooked',
  kcal: 130,
  proteinG: 2.7,
  carbsG: 28.2,
  fatG: 0.3,
  fibreG: 0.4,
  ironMg: 0.2,
  magnesiumMg: 12,
  calciumMg: 10,
  zincMg: 0.6,
  servings: null,
  nonVeg: false,
  createdByUserId: null,
  verified: false,
};

const PANEER = {
  id: 2,
  name: 'Paneer',
  aliases: ['paneer', 'cottage cheese'],
  basis: 'as_served',
  kcal: 265,
  proteinG: 18,
  carbsG: 3.6,
  fatG: 20,
  fibreG: 0,
  ironMg: 1,
  magnesiumMg: 28,
  calciumMg: 250,
  zincMg: 1.1,
  servings: null,
  nonVeg: false,
  createdByUserId: null,
  verified: true,
};

const CUSTOM = { ...RICE, id: 9, name: "Ma's special", createdByUserId: 7, verified: false };

// --- portion maths ---------------------------------------------------------

test('a 100 g portion is the food\'s own numbers', () => {
  const p = computePortion(RICE, 100);
  assert.equal(p.kcal, 130);
  assert.equal(p.proteinG, 2.7);
  assert.equal(p.fibreG, 0.4);
});

test('portion scales linearly and rounds once', () => {
  const p = computePortion(RICE, 150);
  assert.equal(p.kcal, 195);
  assert.equal(p.proteinG, 4.05);
  assert.equal(p.carbsG, 42.3);
  // Rounded at storage time, not display time.
  assert.equal(p.kcal, Number(p.kcal.toFixed(2)));
});

test('a missing micronutrient stays null rather than becoming zero', () => {
  // null means "we do not carry this", 0 means "this food contains none".
  // Collapsing the two would make an untracked nutrient look like a shortfall
  // and quietly drag a score down.
  const p = computePortion({ ...RICE, ironMg: null, zincMg: 0 }, 200);
  assert.equal(p.ironMg, null);
  assert.equal(p.zincMg, 0);
});

// --- search ----------------------------------------------------------------

test('search excludes unverified catalogue rows by default', async () => {
  let seen;
  const prisma = mockPrisma({
    foodItem: {
      findMany: async (args) => {
        seen = args.where;
        return [];
      },
    },
  });
  await searchFoods(prisma, 7, { query: 'rice' });
  assert.deepEqual(seen.AND, [{ OR: [{ verified: true }, { createdByUserId: 7 }] }]);
});

test('a user\'s own unverified food is still findable when the catalogue is filtered', async () => {
  // The verification flag is about OUR data, not theirs. A custom food must not
  // disappear from its own author's search.
  let seen;
  const prisma = mockPrisma({
    foodItem: {
      findMany: async (args) => {
        seen = args.where;
        return [CUSTOM];
      },
    },
  });
  const rows = await searchFoods(prisma, 7, { query: 'special' });
  assert.equal(rows.length, 1);
  assert.ok(seen.AND[0].OR.some((c) => c.createdByUserId === 7));
});

test('includeUnverified drops the filter entirely', async () => {
  let seen;
  const prisma = mockPrisma({
    foodItem: { findMany: async (a) => ((seen = a.where), []) },
  });
  await searchFoods(prisma, 7, { query: 'rice', includeUnverified: true });
  assert.deepEqual(seen.AND, []);
});

test('an empty query searches nothing rather than everything', async () => {
  const prisma = mockPrisma();
  assert.deepEqual(await searchFoods(prisma, 7, { query: '   ' }), []);
});

// --- logging ---------------------------------------------------------------

test('logging writes a snapshot of the food\'s values at log time', async () => {
  let created;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => RICE },
    foodLog: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  await logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 1, grams: 200 });
  assert.equal(created.grams, 200);
  assert.equal(created.nutrients.kcal, 260);
  assert.equal(created.name, 'Rice, cooked (white)');
  assert.equal(created.nonVeg, false);
});

test('the snapshot is a copy, so later edits to the food do not reach the log', async () => {
  // The point of the snapshot: an admin correcting paneer's fat must not
  // rewrite what was eaten last month.
  let created;
  let food = { ...PANEER };
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => food },
    foodLog: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  await logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 2, grams: 100 });
  assert.equal(created.nutrients.fatG, 20);
  food = { ...food, fatG: 40 };
  assert.equal(created.nutrients.fatG, 20);
});

test('a portion can be given in household servings', async () => {
  const food = { ...RICE, servings: [{ label: '1 katori', grams: 150 }] };
  let created;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => food },
    foodLog: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  await logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 1, servings: 1 });
  assert.equal(Number(created.grams), 150);
  assert.equal(created.nutrients.kcal, 195);
});

test('grams win when both grams and servings are sent', async () => {
  // Someone correcting a portion by hand means the grams.
  const food = { ...RICE, servings: [{ label: '1 katori', grams: 150 }] };
  let created;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => food },
    foodLog: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  await logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 1, grams: 100, servings: 3 });
  assert.equal(Number(created.grams), 100);
});

test('a bad slot is rejected before anything is read', async () => {
  const prisma = mockPrisma();
  await assert.rejects(
    () => logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'brunch', foodItemId: 1, grams: 100 }),
    /slot must be one of/,
  );
});

test('zero or missing grams is rejected', async () => {
  const prisma = mockPrisma({ foodItem: { findUnique: async () => RICE } });
  await assert.rejects(
    () => logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 1, grams: 0 }),
    /Provide grams/,
  );
});

test('an absurd portion is rejected', async () => {
  const prisma = mockPrisma({ foodItem: { findUnique: async () => RICE } });
  await assert.rejects(
    () => logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 1, grams: 9000 }),
    /more food than one meal/,
  );
});

test("another user's custom food is not loggable", async () => {
  const prisma = mockPrisma({ foodItem: { findUnique: async () => ({ ...CUSTOM, createdByUserId: 99 }) } });
  await assert.rejects(
    () => logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 9, grams: 100 }),
    /not in the catalogue/,
  );
});

// --- daily totals ----------------------------------------------------------

test('day totals add the snapshots, bucketed by slot', async () => {
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => [
        { slot: 'breakfast', nutrients: { kcal: 260, proteinG: 4.05, carbsG: 42.3, fatG: 0.45, fibreG: 0.6 } },
        { slot: 'lunch', nutrients: { kcal: 530, proteinG: 36, carbsG: 7.2, fatG: 40, fibreG: 0 } },
        { slot: 'lunch', nutrients: { kcal: 130, proteinG: 2.7, carbsG: 28.2, fatG: 0.3, fibreG: 0.4 } },
      ],
    },
  });
  const day = await getDayTotals(prisma, 7, '2026-09-28');
  assert.equal(day.logCount, 3);
  assert.equal(day.totals.kcal, 920);
  assert.equal(day.totals.proteinG, 42.75);
  assert.equal(day.bySlot.lunch.count, 2);
  assert.equal(day.bySlot.lunch.totals.kcal, 660);
  assert.equal(day.bySlot.dinner.count, 0);
  assert.equal(day.bySlot.dinner.totals.kcal, 0);
});

test('every slot is present even on an empty day', async () => {
  const prisma = mockPrisma({ foodLog: { findMany: async () => [] } });
  const day = await getDayTotals(prisma, 7, '2026-09-28');
  for (const slot of ['breakfast', 'lunch', 'snack', 'dinner']) {
    assert.ok(day.bySlot[slot], `${slot} missing from an empty day`);
    assert.equal(day.bySlot[slot].totals.kcal, 0);
  }
  assert.deepEqual(day.logs, [], 'an empty day lists nothing');
});

test('day totals carry the rows themselves, not just their sum', async () => {
  // The food card lists what was eaten under each meal, so the rows have to
  // arrive with the numbers. They come from the same read the loop above
  // already did: a count and a list fetched separately can disagree by one
  // entry, and the count is printed directly over the list.
  const rows = [
    { id: 11, slot: 'breakfast', name: 'Poha', nutrients: { kcal: 260 } },
    { id: 12, slot: 'lunch', name: 'Dal', nutrients: { kcal: 530 } },
  ];
  const prisma = mockPrisma({ foodLog: { findMany: async () => rows } });
  const day = await getDayTotals(prisma, 7, '2026-09-28');
  assert.equal(day.logs.length, 2);
  assert.equal(day.logs[0].name, 'Poha');
  assert.equal(day.logCount, day.logs.length);
});

// --- correcting one entry --------------------------------------------------

const LOGGED = {
  id: 42,
  userId: 7,
  foodItemId: 1,
  slot: 'lunch',
  grams: 150,
  servingLabel: '150 g',
  servings: null,
  nutrients: { kcal: 195 },
  source: 'search',
  photoCorrections: 0,
  photoPath: null,
};

test('resizing an entry recomputes its snapshot from the food', async () => {
  let seen;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => RICE },
    foodLog: {
      findFirst: async () => ({ ...LOGGED }),
      update: async (a) => ((seen = a.data), { id: 42, ...a.data }),
    },
  });
  const out = await updateLog(prisma, 7, 42, { grams: 1000 });
  assert.equal(seen.grams, 1000);
  assert.equal(seen.nutrients.kcal, 1300, '1000 g of a 130 kcal/100 g food');
  assert.equal(seen.servings, null);
  // The old label described the old portion, so it goes with it.
  assert.equal(seen.servingLabel, null);
  assert.equal(out.id, 42);
});

test('a resize into a custom food the user does not own is a 404', async () => {
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => ({ ...CUSTOM, createdByUserId: 99 }) },
    foodLog: { findFirst: async () => ({ ...LOGGED }) },
  });
  await assert.rejects(() => updateLog(prisma, 7, 42, { grams: 200 }), (err) => err.status === 404);
});

test('the meal a log sits in can be moved on its own', async () => {
  let seen;
  const prisma = mockPrisma({
    foodLog: {
      findFirst: async () => ({ ...LOGGED }),
      update: async (a) => ((seen = a.data), { id: 42, ...a.data }),
    },
  });
  await updateLog(prisma, 7, 42, { slot: 'dinner' });
  assert.equal(seen.slot, 'dinner');
  assert.equal(seen.nutrients, undefined, 'moving a row must not touch its numbers');
  assert.equal(seen.grams, undefined);
});

test('a row with no food behind it cannot be re-portioned', async () => {
  // Two different rows reach this: a photo line the catalogue never matched,
  // and a food since deleted (onDelete: SetNull). Neither has anything left to
  // scale, so the size is refused - but the meal can still move, and the
  // message has to say which half is impossible rather than failing the whole
  // edit with a bare 400.
  const unmatched = {
    ...LOGGED,
    id: 51,
    foodItemId: null,
    nutrients: { unknown: true },
    photoPath: 'food/7/abc.jpg',
  };
  const prisma = mockPrisma({
    foodLog: { findFirst: async () => ({ ...unmatched }) },
  });
  await assert.rejects(
    () => updateLog(prisma, 7, 51, { grams: 200 }),
    (err) => err.status === 400 && err.code === 'NO_FOOD_TO_SCALE' && /no nutrition attached/.test(err.message),
  );
  // ...and the part that does not need a food still goes through.
  const moved = mockPrisma({
    foodLog: {
      findFirst: async () => ({ ...unmatched }),
      update: async (a) => ({ id: 51, ...a.data }),
    },
  });
  const out = await updateLog(moved, 7, 51, { slot: 'snack' });
  assert.equal(out.slot, 'snack');
});

test('correcting a photo row counts against the photo feature metric', async () => {
  // The launch metric is "photo-derived rows the user had to correct". The
  // confirm-time counter cannot see an edit made afterwards, so a resize of a
  // photo row is exactly the correction it is missing.
  let seen;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => RICE },
    foodLog: {
      findFirst: async () => ({ ...LOGGED, photoPath: 'food/7/abc.jpg', photoCorrections: 1 }),
      update: async (a) => ((seen = a.data), { id: 42, ...a.data }),
    },
  });
  await updateLog(prisma, 7, 42, { grams: 200 });
  assert.equal(seen.photoCorrections, 2);

  // A search row is not a photo row, so it never moves the counter.
  const plain = mockPrisma({
    foodItem: { findUnique: async () => RICE },
    foodLog: {
      findFirst: async () => ({ ...LOGGED }),
      update: async (a) => ((seen = a.data), { id: 42, ...a.data }),
    },
  });
  await updateLog(plain, 7, 42, { grams: 200 });
  assert.equal(seen.photoCorrections, undefined);
});

test('an edit that changes nothing, or reaches for someone else, is refused', async () => {
  const empty = mockPrisma({ foodLog: { findFirst: async () => ({ ...LOGGED }) } });
  await assert.rejects(
    () => updateLog(empty, 7, 42, {}),
    (err) => err.status === 400 && /Nothing to change/.test(err.message),
  );

  const missing = mockPrisma({ foodLog: { findFirst: async () => null } });
  await assert.rejects(
    () => updateLog(missing, 7, 999, { grams: 100 }),
    (err) => err.status === 404,
  );

  const badSlot = mockPrisma({ foodLog: { findFirst: async () => ({ ...LOGGED }) } });
  await assert.rejects(
    () => updateLog(badSlot, 7, 42, { slot: 'midnight' }),
    /slot must be one of/,
  );
});

test('a FoodLog update only names columns the model has', async () => {
  // Same hole as the create test above: the mock accepts any key, so a typo in
  // an UPDATE passes here and fails against a real database.
  let data;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => RICE },
    foodLog: {
      findFirst: async () => ({ ...LOGGED }),
      update: async (a) => ((data = a.data), { id: 42, ...a.data }),
    },
  });
  await updateLog(prisma, 7, 42, { grams: 250, slot: 'dinner', servingLabel: 'a bowl' });
  const fields = modelFields('FoodLog');
  const unknown = Object.keys(data).filter((k) => !fields.has(k));
  assert.deepEqual(unknown, [], `FoodLog has no column(s): ${unknown.join(', ')}`);
});

// --- known-unknown rows (photo_unmatched) ------------------------------------

test('logUnknownFood writes a sentinel row that totals count but never sum', async () => {
  // A confirmed-but-unmatched photo line is PRESENT in the meal - it was on the
  // plate - and must never be re-invented into numbers. The log keeps the name
  // and the photo; totals keep it countable but out of every sum. Also, an
  // empty day has no pending rows.
  const prisma = mockPrisma({ foodLog: { findMany: async () => [] } });
  const empty = await getDayTotals(prisma, 7, '2026-09-28');
  assert.equal(empty.pendingCount, 0);

  const unknown = await logUnknownFood(prisma, {
    userId: 7,
    localDate: '2026-09-28',
    slot: 'dinner',
    grams: 100,
    name: 'Amla pickle, homemade',
    photo: { path: 'food/7/abc.jpg', proposedName: 'Amla pickle', confidence: 0.71, model: 'gemini-3.5-flash' },
  });
  assert.equal(unknown.source, 'photo_unmatched');
  assert.deepEqual(unknown.nutrients, { unknown: true });
  assert.equal(unknown.foodItemId, null);
  assert.equal(unknown.name, 'Amla pickle, homemade');
  assert.equal(unknown.photoPath, 'food/7/abc.jpg');
  assert.equal(isUnknownSnapshot(unknown.nutrients), true);
});

test('day totals count a pending row and keep it out of the sums', async () => {
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => [
        { slot: 'lunch', nutrients: { kcal: 530, proteinG: 36, carbsG: 7.2, fatG: 40, fibreG: 0 } },
        { slot: 'dinner', nutrients: { unknown: true } },
        { slot: 'dinner', nutrients: { kcal: 130, proteinG: 2.7, carbsG: 28.2, fatG: 0.3, fibreG: 0.4 } },
      ],
    },
  });

  const day = await getDayTotals(prisma, 7, '2026-09-28');
  // The unknown row is a real entry in the day, so it counts.
  assert.equal(day.logCount, 3);
  assert.equal(day.pendingCount, 1);
  assert.equal(day.bySlot.dinner.count, 2);
  assert.equal(day.bySlot.dinner.pendingCount, 1);
  // ...and it contributes nothing to any number, so the day's totals are only
  // the measured rows. The alternative - a silent 0 kcal - makes the day look
  // lighter than it was, which is exactly the wrong direction.
  assert.equal(day.totals.kcal, 660);
  assert.equal(day.bySlot.dinner.totals.kcal, 130);
  assert.equal(day.bySlot.dinner.totals.fatG, 0.3);
});

test('logUnknownFood requires a name and a real slot and sane grams', async () => {
  const base = { userId: 7, localDate: '2026-09-28', slot: 'dinner', grams: 100, name: 'Unknown thing' };
  await assert.rejects(
    () => logUnknownFood(mockPrisma(), { ...base, name: '   ' }),
    (err) => err.status === 400 && err.code === 'NAME_REQUIRED',
  );
  await assert.rejects(
    () => logUnknownFood(mockPrisma(), { ...base, slot: 'midnight' }),
    /slot must be one of/,
  );
  await assert.rejects(
    () => logUnknownFood(mockPrisma(), { ...base, grams: 0 }),
    /Provide grams/,
  );
  await assert.rejects(
    () => logUnknownFood(mockPrisma(), { ...base, grams: 99999 }),
    /more food than one meal/,
  );
});

test('logQuickFood stores a user-typed food with a calorie it actually counts', async () => {
  // The third writer. It must WRITE NUMBERS, not a sentinel - a hand-entered
  // "about 350" is a deliberate estimate and belongs in the day's total, which
  // is the whole point of choosing it over "log without nutrition".
  let created;
  const prisma = mockPrisma({
    foodLog: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  const log = await logQuickFood(prisma, {
    userId: 7,
    localDate: '2026-09-28',
    slot: 'lunch',
    name: "Mom's rajma",
    kcal: 350,
    grams: 250,
    servingLabel: '1 katori',
  });

  assert.equal(log.source, 'custom');
  assert.equal(log.foodItemId, null);
  assert.equal(log.name, "Mom's rajma");
  assert.equal(created.nutrients.kcal, 350);
  // The macros are NOT back-filled from the one number the user gave.
  assert.equal(created.nutrients.proteinG, 0);
  assert.equal(created.nutrients.fatG, 0);
  assert.equal(isUnknownSnapshot(created.nutrients), false);
  assert.equal(created.grams, 250);
  // It is a real number, so a day totals read sums it.
  const day = await getDayTotals(
    mockPrisma({ foodLog: { findMany: async () => [{ slot: 'lunch', nutrients: created.nutrients }] } }),
    7,
    '2026-09-28',
  );
  assert.equal(day.totals.kcal, 350);
  assert.equal(day.pendingCount, 0);
});

test('logQuickFood requires a name, positive calories and sane grams', async () => {
  const base = { userId: 7, localDate: '2026-09-28', slot: 'lunch', name: 'Something', kcal: 200, grams: 100 };
  await assert.rejects(
    () => logQuickFood(mockPrisma(), { ...base, name: '  ' }),
    (err) => err.status === 400 && err.code === 'NAME_REQUIRED',
  );
  // No calories is not a zero-calorie food; it is an unfinished entry.
  await assert.rejects(
    () => logQuickFood(mockPrisma(), { ...base, kcal: 0 }),
    (err) => err.status === 400 && err.code === 'KCAL_REQUIRED',
  );
  await assert.rejects(
    () => logQuickFood(mockPrisma(), { ...base, kcal: 99999 }),
    /over 5000 kcal/,
  );
  await assert.rejects(
    () => logQuickFood(mockPrisma(), { ...base, grams: 0 }),
    /Provide grams/,
  );
  await assert.rejects(
    () => logQuickFood(mockPrisma(), { ...base, slot: 'midnight' }),
    /slot must be one of/,
  );
});

// --- target comparison -----------------------------------------------------

test('delta is positive when under target, negative when over', () => {
  const totals = { kcal: 1800, proteinG: 60, carbsG: 200, fatG: 60, fibreG: 20, ironMg: 8 };
  const target = { kcal: 2000, proteinG: 100, carbsG: 220, fatG: 65, fibreG: 28, ironMg: 10 };
  const d = deltaFromTarget(totals, target);
  // The sign convention the score engine depends on. An inversion here would
  // reward overeating, so it is asserted explicitly rather than implied.
  assert.equal(d.kcal, 200);
  assert.equal(d.proteinG, 40);
  assert.equal(d.fatG, 5);
});

test('a null target nutrient yields a null delta, not zero', () => {
  const d = deltaFromTarget({ kcal: 100 }, { kcal: 200, ironMg: null });
  assert.equal(d.ironMg, null);
});

test('progress is a 0..1 fraction and cannot exceed 1', () => {
  const p = progressAgainstTarget(
    { kcal: 2500, proteinG: 50, carbsG: 200, fatG: 60, fibreG: 10 },
    { kcal: 2000, proteinG: 100, carbsG: 220, fatG: 65, fibreG: 28 },
  );
  // Someone on their first day should not see "148% of calories used".
  assert.equal(p.kcal, 1);
  assert.equal(p.proteinG, 0.5);
  assert.equal(p.fibreG, Number((10 / 28).toFixed(4)));
});

test('progress against a zero or absent target is null, not a divide by zero', () => {
  const p = progressAgainstTarget({ kcal: 100 }, { kcal: 0 });
  assert.equal(p.kcal, null);
});

// --- saved meals -----------------------------------------------------------

test('a saved meal copies each line\'s snapshot and name', async () => {
  let created;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => [
        { foodItemId: 1, grams: 150, servingLabel: '1 katori', nutrients: { kcal: 195 }, name: 'Rice', nonVeg: false },
        { foodItemId: 2, grams: 100, servingLabel: null, nutrients: { kcal: 265 }, name: 'Paneer', nonVeg: false },
      ],
    },
    savedMeal: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  await saveMeal(prisma, { userId: 7, name: '  Usual lunch  ', slot: 'lunch', localDate: '2026-09-28' });
  assert.equal(created.name, 'Usual lunch');
  assert.equal(created.lines.create.length, 2);
  assert.equal(created.lines.create[0].nutrients.kcal, 195);
  // SavedMealLine has no userId column - the parent SavedMeal carries
  // ownership. The assertion used to check for `userId: 7` here, which
  // enshrined a Prisma write that could only ever fail against a real
  // database while passing against the mock.
  assert.equal('userId' in created.lines.create[0], false);
  // Order is what keeps a repeated meal reading the way it was eaten.
  assert.equal(created.lines.create[0].order, 0);
  assert.equal(created.lines.create[1].order, 1);
});

test('saving an empty meal is rejected', async () => {
  const prisma = mockPrisma({ foodLog: { findMany: async () => [] } });
  await assert.rejects(
    () => saveMeal(prisma, { userId: 7, name: 'Nothing', slot: 'lunch', localDate: '2026-09-28' }),
    /nothing logged/,
  );
});

test('repeating a saved meal copies the snapshot, not the live food', async () => {
  let createdMany;
  const prisma = mockPrisma({
    foodItem: { findMany: async () => [{ id: 1 }] },
    savedMeal: {
      findFirst: async () => ({
        id: 5,
        name: 'Usual lunch',
        slot: 'lunch',
        lines: [{ foodItemId: 1, grams: 150, servingLabel: '1 katori', nutrients: { kcal: 195 }, name: 'Rice', nonVeg: false }],
      }),
    },
    foodLog: { createMany: async (a) => ((createdMany = a.data), { count: a.data.length }) },
  });
  const out = await logSavedMeal(prisma, { userId: 7, savedMealId: 5, localDate: '2026-09-29' });
  assert.equal(out.logged, 1);
  assert.equal(createdMany[0].nutrients.kcal, 195);
  assert.equal(createdMany[0].source, 'saved_meal');
  assert.deepEqual(out.skipped, []);
});

test('a line whose food was deleted is skipped, not fatal', async () => {
  // Deleting a custom food must not make "my usual breakfast" unloggable. The
  // rest of the meal still goes in, and the caller is told what was dropped.
  let createdMany;
  const prisma = mockPrisma({
    foodItem: { findMany: async () => [{ id: 1 }] },
    savedMeal: {
      findFirst: async () => ({
        id: 5,
        name: 'Breakfast',
        slot: 'breakfast',
        lines: [
          { foodItemId: 1, grams: 100, nutrients: { kcal: 130 }, name: 'Rice', nonVeg: false },
          { foodItemId: 42, grams: 30, nutrients: { kcal: 99 }, name: 'Deleted thing', nonVeg: false },
        ],
      }),
    },
    foodLog: { createMany: async (a) => ((createdMany = a.data), { count: a.data.length }) },
  });
  const out = await logSavedMeal(prisma, { userId: 7, savedMealId: 5, localDate: '2026-09-29' });
  assert.equal(out.logged, 1);
  assert.equal(createdMany.length, 1);
  assert.deepEqual(out.skipped, ['Deleted thing']);
});

test('repeating a meal with nothing left fails clearly', async () => {
  const prisma = mockPrisma({
    foodItem: { findMany: async () => [] },
    savedMeal: {
      findFirst: async () => ({
        id: 5,
        name: 'Breakfast',
        slot: 'breakfast',
        lines: [{ foodItemId: 42, grams: 30, nutrients: {}, name: 'Deleted thing', nonVeg: false }],
      }),
    },
  });
  await assert.rejects(
    () => logSavedMeal(prisma, { userId: 7, savedMealId: 5, localDate: '2026-09-29' }),
    /are available any more/,
  );
});

test('another user\'s saved meal cannot be repeated', async () => {
  const prisma = mockPrisma({ savedMeal: { findFirst: async () => null } });
  await assert.rejects(
    () => logSavedMeal(prisma, { userId: 7, savedMealId: 5, localDate: '2026-09-29' }),
    /No such saved meal/,
  );
});

test('an empty localDate is refused rather than logged to no day', async () => {
  // The client once sent '' when the day read had not landed. createMany would
  // have accepted it - the column is a String - so the repeat would have
  // reported success while writing rows `getDayTotals` (`where: { localDate }`)
  // could never match again.
  const prisma = mockPrisma({
    foodLog: { createMany: async () => { throw new Error('must not write'); } },
  });
  await assert.rejects(
    () => logSavedMeal(prisma, { userId: 7, savedMealId: 5, localDate: '' }),
    /localDate must be YYYY-MM-DD/,
  );
});

test('a malformed localDate is refused', async () => {
  const prisma = mockPrisma({});
  await assert.rejects(
    () => logSavedMeal(prisma, { userId: 7, savedMealId: 5, localDate: '2026-13-45' }),
    /localDate must be YYYY-MM-DD/,
  );
});

test('emptyTotals starts every nutrient at zero', () => {
  const t = emptyTotals();
  assert.equal(t.kcal, 0);
  assert.equal(t.ironMg, 0);
  assert.deepEqual(Object.keys(t).length, 9);
});

// --- write shape vs. the schema -----------------------------------------
//
// The suite above hands every prisma call a mock that accepts whatever it is
// given, so a write naming a column that does not exist passes here and fails
// against a real database. That is not hypothetical: logFood defaulted to
// source: 'manual' - not a member of the FoodLogSource enum - and saveMeal wrote
// userId onto SavedMealLine, which has no such column. Both were green.
//
// So the writes are checked against the actual schema. It cannot catch a
// wrong-but-existing column, but it does catch the failure that a mock cannot
// see at all.

const schemaSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'schema.prisma'),
  'utf8',
);

function modelFields(name) {
  const body = schemaSource.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
  return new Set(
    [...body.matchAll(/^\s{2}(\w+)\s+\w/mg)].map((m) => m[1]),
  );
}

function enumValues(name) {
  const body = schemaSource.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\w+$/.test(l));
}

test('a FoodLog write only names columns the model has', async () => {
  let data;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => ({ id: 1, name: 'Rice', grams: 100, servings: 1, nutrients: {} }) },
    foodLog: { create: async (a) => ((data = a.data), { id: 1, ...a.data }) },
  });
  await logFood(prisma, {
    userId: 7,
    localDate: '2026-09-28',
    slot: 'lunch',
    foodItemId: 1,
    grams: 150,
  });
  const fields = modelFields('FoodLog');
  const unknown = Object.keys(data).filter((k) => !fields.has(k));
  assert.deepEqual(unknown, [], `FoodLog has no column(s): ${unknown.join(', ')}`);
});

test('the default source is a member of the FoodLogSource enum', async () => {
  // The regression: the default was 'manual', which is not in the enum, so a
  // caller that omitted `source` got a Prisma enum error as a 500.
  const values = enumValues('FoodLogSource');
  let data;
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => ({ id: 1, name: 'Rice', servings: 1 }) },
    foodLog: { create: async (a) => ((data = a.data), { id: 1, ...a.data }) },
  });
  await logFood(prisma, { userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 1, grams: 150 });
  assert.ok(values.includes(data.source), `'${data.source}' is not a FoodLogSource value`);
});

test('an unknown source is a 400, not a Prisma error', async () => {
  const prisma = mockPrisma({
    foodItem: { findUnique: async () => ({ id: 1, name: 'Rice', servings: 1 }) },
  });
  await assert.rejects(
    () => logFood(prisma, {
      userId: 7, localDate: '2026-09-28', slot: 'lunch', foodItemId: 1, grams: 150, source: 'manual',
    }),
    /source must be one of/,
  );
});

test('a SavedMealLine write only names columns the model has', async () => {
  let data;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => [
        { foodItemId: 1, grams: 150, servingLabel: null, nutrients: { kcal: 195 }, name: 'Rice', nonVeg: false },
      ],
    },
    savedMeal: { create: async (a) => ((data = a.data), { id: 1, ...a.data }) },
  });
  await saveMeal(prisma, { userId: 7, name: 'Lunch', slot: 'lunch', localDate: '2026-09-28' });
  const fields = modelFields('SavedMealLine');
  assert.ok(fields.size, 'SavedMealLine was not found in the schema, so this test is vacuous');
  const unknown = Object.keys(data.lines.create[0]).filter((k) => !fields.has(k));
  assert.deepEqual(unknown, [], `SavedMealLine has no column(s): ${unknown.join(', ')}`);
});

test('repeating a saved meal asks for its lines', async () => {
  // The mock in this file returns a meal with `lines` no matter what the query
  // asked for, so the missing `include: { lines: true }` was invisible here.
  // Against a real client, meal.lines was undefined and the loop threw.
  let seen;
  const prisma = mockPrisma({
    savedMeal: {
      findFirst: async (args) => {
        seen = args;
        return { id: 5, name: 'Breakfast', slot: 'breakfast', lines: [] };
      },
    },
  });
  await logSavedMeal(prisma, { userId: 7, savedMealId: 5, localDate: '2026-09-29' }).catch(() => {});
  assert.ok(
    seen?.include?.lines,
    'logSavedMeal iterates meal.lines, so the query must include them',
  );
});

// --- recent foods ----------------------------------------------------------

test('recent foods dedupe by food and keep the newest portion', async () => {
  let query;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async (args) => {
        query = args;
        return [
          { foodItemId: 1, grams: 180, servingLabel: '1 bowl', localDate: '2026-09-30' },
          { foodItemId: 2, grams: 100, servingLabel: null, localDate: '2026-09-30' },
          // An older log of food 1 must not appear a second time.
          { foodItemId: 1, grams: 120, servingLabel: null, localDate: '2026-09-29' },
        ];
      },
    },
    foodItem: {
      findMany: async () => [RICE, PANEER],
    },
  });

  const out = await recentFoods(prisma, 7, { limit: 8 });
  assert.deepEqual(out.map((r) => r.food.id), [1, 2]);
  assert.equal(out[0].grams, 180, 'the last portion logged, not the first');
  assert.equal(out[0].servingLabel, '1 bowl');
  // Scoped to the user and to catalogue-backed logs; a hand-typed custom row has
  // no FoodItem to show in the list.
  assert.equal(query.where.userId, 7);
  assert.deepEqual(query.where.foodItemId, { not: null });
});

test('recent foods drops a food that has since been deleted', async () => {
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => [
        { foodItemId: 1, grams: 100, servingLabel: null },
        { foodItemId: 42, grams: 100, servingLabel: null },
      ],
    },
    foodItem: { findMany: async () => [RICE] },
  });
  const out = await recentFoods(prisma, 7, {});
  assert.deepEqual(out.map((r) => r.food.id), [1]);
});

test('recent foods is empty, not a crash, for a new user', async () => {
  const out = await recentFoods(mockPrisma({}), 7, {});
  assert.deepEqual(out, []);
});

test('recent foods caps the read at five times the requested list', async () => {
  // The wider read is what makes dedupe still fill a short list; the cap is what
  // keeps an active logger from reading a thousand rows to show eight.
  let query;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async (args) => ((query = args), []),
    },
  });
  await recentFoods(prisma, 7, { limit: 30 });
  assert.equal(query.take, 150);
});

// --- repeat a day ----------------------------------------------------------

const DAY_LOGS = [
  { foodItemId: 1, slot: 'breakfast', grams: 150, servingLabel: '1 katori', nutrients: { kcal: 195 }, name: 'Rice', nonVeg: false, source: 'search', servings: null },
  { foodItemId: 2, slot: 'lunch', grams: 100, servingLabel: null, nutrients: { kcal: 265 }, name: 'Paneer', nonVeg: false, source: 'search', servings: 1 },
];

test('repeating a day copies each row\'s snapshot, source and slot', async () => {
  let created;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => DAY_LOGS,
      createMany: async (a) => ((created = a.data), { count: a.data.length }),
    },
    foodItem: { findMany: async () => [{ id: 1 }, { id: 2 }] },
  });

  const out = await repeatDay(prisma, {
    userId: 7,
    fromLocalDate: '2026-09-29',
    localDate: '2026-09-30',
  });
  assert.equal(out.logged, 2);
  assert.deepEqual(out.skipped, []);
  assert.equal(created[0].localDate, '2026-09-30', 'the copy lands on the target day');
  assert.equal(created[0].nutrients.kcal, 195, 'the snapshot is copied, not recomputed');
  assert.equal(created[0].source, 'search', 'a copied row keeps its own provenance');
  assert.equal(created[0].slot, 'breakfast', 'no forced slot keeps each row in its meal');
  assert.equal(created[1].slot, 'lunch');
});

test('a forced slot moves every copied row into that meal', async () => {
  let created;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => DAY_LOGS,
      createMany: async (a) => ((created = a.data), { count: a.data.length }),
    },
    foodItem: { findMany: async () => [{ id: 1 }, { id: 2 }] },
  });
  await repeatDay(prisma, {
    userId: 7,
    fromLocalDate: '2026-09-29',
    localDate: '2026-09-30',
    slot: 'dinner',
  });
  assert.deepEqual(created.map((r) => r.slot), ['dinner', 'dinner']);
});

test('a row whose food left the catalogue is skipped and named', async () => {
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => [
        DAY_LOGS[0],
        { ...DAY_LOGS[1], foodItemId: 42, name: 'Deleted thing' },
      ],
      createMany: async (a) => ({ count: a.data.length }),
    },
    foodItem: { findMany: async () => [{ id: 1 }] },
  });
  const out = await repeatDay(prisma, {
    userId: 7,
    fromLocalDate: '2026-09-29',
    localDate: '2026-09-30',
  });
  assert.equal(out.logged, 1);
  assert.deepEqual(out.skipped, ['Deleted thing']);
});

test('a custom row with no catalogue food is copied as-is', async () => {
  // A hand-typed row has foodItemId null, so there is nothing to have gone
  // missing; it must not be swept into `skipped` by the catalogue check.
  let created;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => [
        { foodItemId: null, slot: 'snack', grams: 100, servingLabel: null, nutrients: { kcal: 350 }, name: "Mom's rajma", nonVeg: false, source: 'custom', servings: null },
      ],
      createMany: async (a) => ((created = a.data), { count: a.data.length }),
    },
  });
  const out = await repeatDay(prisma, {
    userId: 7,
    fromLocalDate: '2026-09-29',
    localDate: '2026-09-30',
  });
  assert.equal(out.logged, 1);
  assert.deepEqual(out.skipped, []);
  assert.equal(created[0].foodItemId, null);
  assert.equal(created[0].source, 'custom');
});

test('repeating from a day with nothing logged fails clearly', async () => {
  const prisma = mockPrisma({ foodLog: { findMany: async () => [] } });
  await assert.rejects(
    () => repeatDay(prisma, { userId: 7, fromLocalDate: '2026-09-29', localDate: '2026-09-30' }),
    /nothing logged on that day/,
  );
});

test('repeating a day onto itself is refused before any write', async () => {
  // The client computes "yesterday"; a bug there must not silently double today.
  const prisma = mockPrisma({
    foodLog: { createMany: async () => { throw new Error('must not write'); } },
  });
  await assert.rejects(
    () => repeatDay(prisma, { userId: 7, fromLocalDate: '2026-09-30', localDate: '2026-09-30' }),
    /different day/,
  );
});

test('a malformed fromLocalDate is refused', async () => {
  const prisma = mockPrisma({});
  await assert.rejects(
    () => repeatDay(prisma, { userId: 7, fromLocalDate: '2026-9-3', localDate: '2026-09-30' }),
    /fromLocalDate must be YYYY-MM-DD/,
  );
});

test('a repeat copy only names columns the FoodLog model has', async () => {
  // Same class as the logFood/saveMeal write-shape checks above: the mock takes
  // whatever it is handed, so a renamed column only fails against the database.
  let created;
  const prisma = mockPrisma({
    foodLog: {
      findMany: async () => DAY_LOGS,
      createMany: async (a) => ((created = a.data), { count: a.data.length }),
    },
    foodItem: { findMany: async () => [{ id: 1 }, { id: 2 }] },
  });
  await repeatDay(prisma, { userId: 7, fromLocalDate: '2026-09-29', localDate: '2026-09-30' });
  const fields = modelFields('FoodLog');
  const unknown = Object.keys(created[0]).filter((k) => !fields.has(k));
  assert.deepEqual(unknown, [], `FoodLog has no column(s): ${unknown.join(', ')}`);
});
