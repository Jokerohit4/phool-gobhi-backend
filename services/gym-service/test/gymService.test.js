// Business-logic tests for gymService.js.
//
// Target functions (mostly internal, tested via exports that call them):
//   normalizeGymMoney   - via addReview (Decimal fields normalized to numbers)
//   recomputeGymRating  - via addReview (aggregate + gym.update)
//   validateHoursRow    - via upsertOperatingHours
//   slot block logic    - via createSlotBlock
//
// Run: node --experimental-test-module-mocks --test test/gymService.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// In-memory stores shared across all model mocks
const stores = {
  gym: new Map(),
  gymReview: new Map(),
  slotBlock: new Map(),
  gymOperatingHours: new Map(),
  gymSlotPrice: new Map(),
  gymEditRequest: new Map(),
};

let aggregateFn;

function resetStores() {
  for (const s of Object.values(stores)) s.clear();
}

function insertGym(overrides = {}) {
  const g = {
    id: 1, name: 'Iron Paradise', partnerId: 'p1',
    isActive: true, isApproved: false,
    openTime: '06:00', closeTime: '22:00', slotDuration: 60, capacity: 30,
    sessionPrice: 200, quotedPrice: 250, commissionPct: 15,
    weeklyPlanPrice: null, monthlyPlanPrice: null,
    quarterlyPlanPrice: null, sixMonthlyPlanPrice: null, yearlyPlanPrice: null,
    subscriptionCommissionPct: null, subscriptionFlatFeePerUser: null,
    rating: null, ratingCount: 0, ...overrides,
  };
  stores.gym.set(g.id, g);
  return g;
}

let addReview, createSlotBlock, upsertOperatingHours;

// Mock + import in one test (t.mock.module is scoped to the calling test)
test('setup: mock all deps and import gymService', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.gym = {
            findUnique: async ({ where }) => stores.gym.get(where.id) ?? null,
            update: async ({ where, data }) => {
              const existing = stores.gym.get(where.id);
              if (!existing) throw new Error('gym not found');
              Object.assign(existing, data);
              return existing;
            },
          };

          aggregateFn = async () => { throw new Error('aggregate not stubbed'); };

          this.gymReview = {
            aggregate: (...args) => aggregateFn(...args),
            create: async ({ data }) => {
              const id = stores.gymReview.size + 1;
              const row = { id, ...data };
              stores.gymReview.set(id, row);
              return row;
            },
            findUnique: async ({ where }) => stores.gymReview.get(where.id) ?? null,
            delete: async ({ where }) => { stores.gymReview.delete(where.id); },
          };

          this.slotBlock = {
            findFirst: async ({ where }) => {
              for (const b of stores.slotBlock.values()) {
                if (b.gymId === where.gymId && b.date === where.date && b.startTime === where.startTime) return b;
              }
              return null;
            },
            create: async ({ data }) => {
              const id = stores.slotBlock.size + 1;
              const row = { id, ...data };
              stores.slotBlock.set(id, row);
              return row;
            },
            findMany: async ({ where }) => {
              const results = [];
              for (const b of stores.slotBlock.values()) {
                if (where.gymId && b.gymId !== where.gymId) continue;
                if (where.date && b.date !== where.date) continue;
                results.push(b);
              }
              return results;
            },
            deleteMany: async ({ where }) => {
              for (const [id, b] of stores.slotBlock) {
                if (where.id && b.id !== where.id) continue;
                stores.slotBlock.delete(id);
              }
            },
          };

          this.gymOperatingHours = {
            findUnique: async ({ where }) => {
              const key = where.gymId_dayOfWeek;
              for (const h of stores.gymOperatingHours.values()) {
                if (h.gymId === key.gymId && h.dayOfWeek === key.dayOfWeek) return h;
              }
              return null;
            },
            findMany: async ({ where }) => {
              const results = [];
              for (const h of stores.gymOperatingHours.values()) {
                if (where.gymId && h.gymId !== where.gymId) continue;
                results.push(h);
              }
              return results;
            },
            upsert: async ({ where, create, update }) => {
              const key = where.gymId_dayOfWeek;
              for (const h of stores.gymOperatingHours.values()) {
                if (h.gymId === key.gymId && h.dayOfWeek === key.dayOfWeek) {
                  Object.assign(h, update);
                  return h;
                }
              }
              const id = stores.gymOperatingHours.size + 1;
              const row = { id, ...create };
              stores.gymOperatingHours.set(id, row);
              return row;
            },
          };

          this.gymSlotPrice = { deleteMany: async () => {} };

          this.gymEditRequest = {
            create: async ({ data }) => {
              const id = stores.gymEditRequest.size + 1;
              const row = { id, ...data };
              stores.gymEditRequest.set(id, row);
              return row;
            },
          };

          this.$transaction = async (fns) => {
            if (Array.isArray(fns)) return Promise.all(fns);
            return fns(this);
          };
        }
      },
    },
  });

  t.mock.module('../config/cloudinary.js', {
    exports: { default: { uploader: { upload: async () => ({ secure_url: 'https://mock.cloud/img.png' }) } } },
  });
  t.mock.module('../utils/slots.js', {
    exports: { generateTimeSlots: () => [], generateWindowedSlots: () => [] },
  });
  t.mock.module('../utils/slotTiming.js', {
    exports: { getDayOfWeek: () => 1 },
  });
  t.mock.module('../services/placesService.js', {
    exports: { placeAutocomplete: async () => [], placeDetails: async () => ({}) },
  });
  t.mock.module('../services/roadDistanceService.js', {
    exports: { getRoadDistancesKm: async () => [] },
  });

  const mod = await import('../services/gymService.js');
  addReview = mod.addReview;
  createSlotBlock = mod.createSlotBlock;
  upsertOperatingHours = mod.upsertOperatingHours;
});

// normalizeGymMoney

test('normalizeGymMoney: converts Decimal objects to numbers', async () => {
  resetStores();
  insertGym({ isApproved: true });
  aggregateFn = async () => ({ _avg: { rating: 4.5 }, _count: { _all: 1 } });
  const review = await addReview(1, 'c1', 5, 'Great gym');
  assert.equal(typeof review.rating, 'number');
  assert.equal(review.rating, 5);
});

test('normalizeGymMoney: rejects nonexistent gym', async () => {
  resetStores();
  await assert.rejects(() => addReview(999, 'c1', 5, 'x'), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('normalizeGymMoney: passes through plain number fields unchanged', async () => {
  resetStores();
  insertGym({ isApproved: true, sessionPrice: 300, commissionPct: 10 });
  aggregateFn = async () => ({ _avg: { rating: 3.0 }, _count: { _all: 1 } });
  const review = await addReview(1, 'c1', 3, 'Okay');
  assert.equal(review.rating, 3);
});

test('normalizeGymMoney: converts Prisma Decimal mock objects', async () => {
  resetStores();
  const decimalPrice = { toJSON: () => '450.75', valueOf: () => 450.75 };
  insertGym({ isApproved: true, sessionPrice: decimalPrice, commissionPct: decimalPrice });
  aggregateFn = async () => ({ _avg: { rating: 4.0 }, _count: { _all: 1 } });
  const review = await addReview(1, 'c1', 4, 'Good');
  assert.equal(review.rating, 4);
});

// recomputeGymRating

test('recomputeGymRating: computes average from multiple reviews', async () => {
  resetStores();
  insertGym({ isApproved: true });
  aggregateFn = async () => ({
    _avg: { rating: 4.5, equipmentRating: 4.0, cleanlinessRating: 5.0,
            trainerRating: null, valueForMoneyRating: null, staffBehaviourRating: null, crowdRating: null },
    _count: { _all: 2, equipmentRating: 1, cleanlinessRating: 1,
              trainerRating: 0, valueForMoneyRating: 0, staffBehaviourRating: 0, crowdRating: 0 },
  });
  await addReview(1, 'c1', 4, 'Good');
  const gym = stores.gym.get(1);
  assert.equal(gym.rating, 4.5);
  assert.equal(gym.ratingCount, 2);
  assert.equal(gym.equipmentRating, 4.0);
  assert.equal(gym.cleanlinessRating, 5.0);
  assert.equal(gym.trainerRating, null);
  assert.equal(gym.equipmentRatingCount, 1);
  assert.equal(gym.trainerRatingCount, 0);
});

test('recomputeGymRating: zero reviews sets rating to null', async () => {
  resetStores();
  insertGym({ isApproved: true, rating: 4.0, ratingCount: 3 });
  aggregateFn = async () => ({
    _avg: { rating: null, equipmentRating: null, cleanlinessRating: null,
            trainerRating: null, valueForMoneyRating: null, staffBehaviourRating: null, crowdRating: null },
    _count: { _all: 0, equipmentRating: 0, cleanlinessRating: 0,
              trainerRating: 0, valueForMoneyRating: 0, staffBehaviourRating: 0, crowdRating: 0 },
  });
  await addReview(1, 'c1', 5, 'x');
  const gym = stores.gym.get(1);
  assert.equal(gym.rating, null);
  assert.equal(gym.ratingCount, 0);
  assert.equal(gym.equipmentRating, null);
});

test('recomputeGymRating: single review uses exact rating', async () => {
  resetStores();
  insertGym({ isApproved: true });
  aggregateFn = async () => ({
    _avg: { rating: 3.0, equipmentRating: 4.0, cleanlinessRating: null,
            trainerRating: null, valueForMoneyRating: null, staffBehaviourRating: null, crowdRating: null },
    _count: { _all: 1, equipmentRating: 1, cleanlinessRating: 0,
              trainerRating: 0, valueForMoneyRating: 0, staffBehaviourRating: 0, crowdRating: 0 },
  });
  await addReview(1, 'c1', 3, 'Decent');
  const gym = stores.gym.get(1);
  assert.equal(gym.rating, 3.0);
  assert.equal(gym.ratingCount, 1);
  assert.equal(gym.equipmentRating, 4.0);
  assert.equal(gym.cleanlinessRating, null);
});

test('recomputeGymRating: only populated category fields are non-null', async () => {
  resetStores();
  insertGym({ isApproved: true });
  aggregateFn = async () => ({
    _avg: { rating: 4.0, equipmentRating: 5.0, cleanlinessRating: null,
            trainerRating: 3.0, valueForMoneyRating: null, staffBehaviourRating: null, crowdRating: null },
    _count: { _all: 1, equipmentRating: 1, cleanlinessRating: 0,
              trainerRating: 1, valueForMoneyRating: 0, staffBehaviourRating: 0, crowdRating: 0 },
  });
  await addReview(1, 'c1', 4, 'Nice', { equipmentRating: 5, trainerRating: 3 });
  const gym = stores.gym.get(1);
  assert.equal(gym.equipmentRating, 5.0);
  assert.equal(gym.trainerRating, 3.0);
  assert.equal(gym.cleanlinessRating, null);
  assert.equal(gym.valueForMoneyRating, null);
  assert.equal(gym.equipmentRatingCount, 1);
  assert.equal(gym.cleanlinessRatingCount, 0);
});

// validateHoursRow (via upsertOperatingHours)

function makeDays(overrides = {}) {
  const day = (dow, ms = '06:00', me = '12:00', es = '17:00', ee = '21:00') =>
    ({ dayOfWeek: dow, morningStart: ms, morningEnd: me, eveningStart: es, eveningEnd: ee });
  const days = [];
  for (let i = 0; i < 7; i++) days.push(day(i));
  return days.map((d) => ({ ...d, ...overrides[d.dayOfWeek] }));
}

test('validateHoursRow: valid windows pass', async () => {
  resetStores();
  insertGym();
  const result = await upsertOperatingHours(1, 'p1', makeDays());
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 7);
});

test('validateHoursRow: morning end <= start fails', async () => {
  resetStores();
  insertGym();
  await assert.rejects(
    () => upsertOperatingHours(1, 'p1', makeDays({ 0: { morningStart: '12:00', morningEnd: '06:00' } })),
    (err) => { assert.equal(err.status, 400); assert.match(err.error, /morning/i); return true; },
  );
});

test('validateHoursRow: evening end <= start fails', async () => {
  resetStores();
  insertGym();
  await assert.rejects(
    () => upsertOperatingHours(1, 'p1', makeDays({ 0: { eveningStart: '21:00', eveningEnd: '17:00' } })),
    (err) => { assert.equal(err.status, 400); assert.match(err.error, /evening/i); return true; },
  );
});

test('validateHoursRow: evening starts before morning ends fails', async () => {
  resetStores();
  insertGym();
  await assert.rejects(
    () => upsertOperatingHours(1, 'p1', makeDays({ 0: { morningEnd: '18:00', eveningStart: '16:00' } })),
    (err) => { assert.equal(err.status, 400); assert.match(err.error, /evening.*must not start before.*morning/i); return true; },
  );
});

test('validateHoursRow: mismatched start/end (only one null) fails', async () => {
  resetStores();
  insertGym();
  await assert.rejects(
    () => upsertOperatingHours(1, 'p1', makeDays({ 0: { morningStart: '06:00', morningEnd: null } })),
    (err) => { assert.equal(err.status, 400); assert.match(err.error, /must have both start and end/i); return true; },
  );
});

test('validateHoursRow: invalid HH:MM format fails', async () => {
  resetStores();
  insertGym();
  await assert.rejects(
    () => upsertOperatingHours(1, 'p1', makeDays({ 0: { morningStart: '25:00', morningEnd: '12:00' } })),
    (err) => { assert.equal(err.status, 400); assert.match(err.error, /HH:MM/i); return true; },
  );
});

test('validateHoursRow: dayOfWeek out of range fails', async () => {
  resetStores();
  insertGym();
  const days = makeDays();
  days[0] = { ...days[0], dayOfWeek: 7 };
  await assert.rejects(
    () => upsertOperatingHours(1, 'p1', days),
    (err) => { assert.equal(err.status, 400); assert.match(err.error, /dayOfWeek/i); return true; },
  );
});

test('upsertOperatingHours: rejects fewer than 7 days', async () => {
  resetStores();
  insertGym();
  await assert.rejects(
    () => upsertOperatingHours(1, 'p1', makeDays().slice(0, 5)),
    (err) => { assert.equal(err.status, 400); assert.match(err.error, /7 days/i); return true; },
  );
});

// Slot block tests (via createSlotBlock)

test('createSlotBlock: creates block for unapproved gym', async () => {
  resetStores();
  insertGym();
  const block = await createSlotBlock(1, 'p1', {
    date: '2026-09-15', startTime: '08:00', endTime: '09:00',
  });
  assert.equal(block.gymId, 1);
  assert.equal(block.date, '2026-09-15');
  assert.equal(block.startTime, '08:00');
  assert.equal(block.endTime, '09:00');
});

test('createSlotBlock: rejects non-owner partner', async () => {
  resetStores();
  insertGym({ partnerId: 'p1' });
  await assert.rejects(
    () => createSlotBlock(1, 'p2', { date: '2026-09-15', startTime: '08:00', endTime: '09:00' }),
    (err) => { assert.equal(err.status, 403); return true; },
  );
});

test('createSlotBlock: rejects nonexistent gym', async () => {
  resetStores();
  await assert.rejects(
    () => createSlotBlock(999, 'p1', { date: '2026-09-15', startTime: '08:00', endTime: '09:00' }),
    (err) => { assert.equal(err.status, 404); return true; },
  );
});

test('createSlotBlock: duplicate block returns existing (idempotent)', async () => {
  resetStores();
  insertGym();
  const first = await createSlotBlock(1, 'p1', {
    date: '2026-09-15', startTime: '08:00', endTime: '09:00',
  });
  const second = await createSlotBlock(1, 'p1', {
    date: '2026-09-15', startTime: '08:00', endTime: '09:00',
  });
  assert.equal(first.id, second.id);
});

test('createSlotBlock: approved gym creates edit request', async () => {
  resetStores();
  insertGym({ isApproved: true });
  const result = await createSlotBlock(1, 'p1', {
    date: '2026-09-15', startTime: '08:00', endTime: '09:00',
  });
  assert.equal(result.pending, true);
  assert.ok(result.editRequest);
  assert.equal(result.editRequest.changeType, 'slot_block_add');
});
