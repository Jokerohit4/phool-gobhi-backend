// Latency/correctness pass over gym-service read paths. Real router, real
// controllers and services; in-memory Prisma and a stubbed booking-service.
//   - GET /internal/blocks/:gymId (requireInternal) — the route booking-service
//     now uses; the partner-only GET /:id/blocks stays partner-only.
//   - getGymSlots / getGymAvailability: narrow gym read, parallel reads,
//     range blocks, batch slot counts — output identical to the old per-day
//     logic (re-implemented below as the reference).
//   - getGym review cap, getGymReviews / getGymInternalWithSlotPrice parallelism.
// Run with: node --experimental-test-module-mocks --test
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.INTERNAL_API_KEY = 'slots-test-key';
const BOOKING_HOST = 'http://booking-service:5005';
const realFetch = globalThis.fetch;

// ---- fixtures -------------------------------------------------------------
const GYM = {
  id: 1, name: 'Iron', partnerId: 9, isActive: true, isApproved: true, marketplaceEnabled: true,
  capacity: 3, slotDuration: 60, sessionPrice: 200, openTime: '06:00', closeTime: '19:00',
  city: 'Gurugram', rating: 4.5, ratingCount: 40,
};
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => (dayOfWeek === 0
  ? { gymId: 1, dayOfWeek, morningStart: null, morningEnd: null, eveningStart: null, eveningEnd: null }
  : { gymId: 1, dayOfWeek, morningStart: '06:00', morningEnd: '09:00', eveningStart: '17:00', eveningEnd: '19:00' }));
const PRICES = [{ gymId: 1, startTime: '06:00', price: 300 }, { gymId: 1, startTime: '17:00', price: 250 }];

let dates; // availability anchor dates (IST today + i)
let blocks;
let reviews;
let calls; // prisma call log
let gymFindArgs;
let reviewFindArgs;
let barrier; // optional { arrive(): Promise }
let barrierIncludesGym = false; // count the gym row read as a barrier arrival
let bookingMode; // 'range' | 'noRange' | 'down'
let rangeCounts; // { [date]: { [startTime]: n } }
let bookingCalls;
let perDayInflight;
let perDayMaxInflight;
let server, baseUrl;

function makeBarrier(n, waitMs = 400) {
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const b = {
    reached: false,
    arrive: async () => {
      arrived += 1;
      if (arrived >= n) { b.reached = true; release(); }
      await Promise.race([gate, new Promise((r) => setTimeout(r, waitMs))]);
    },
  };
  return b;
}
const arrive = () => (barrier ? barrier.arrive() : Promise.resolve());

function pick(row, select) {
  if (!select) return { ...row, images: [] };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

before(async () => {
  const { mock } = await import('node:test');
  mock.module('@prisma/client', {
    exports: {
      Prisma: {},
      PrismaClient: class {
        constructor() {
          this.gym = {
            findUnique: async (args) => {
              gymFindArgs.push(args);
              calls.push('gym');
              if (barrierIncludesGym) await arrive();
              const row = pick(GYM, args.select);
              if (args.include?.reviews) {
                const rows = [...reviews].sort((a, b) => b.createdAt - a.createdAt);
                row.reviews = args.include.reviews.take ? rows.slice(0, args.include.reviews.take) : rows;
              }
              return row;
            },
          };
          this.gymOperatingHours = {
            findMany: async () => { calls.push('hoursAll'); await arrive(); return HOURS; },
            findUnique: async ({ where }) => {
              calls.push('hoursOne');
              await arrive();
              return HOURS.find((h) => h.dayOfWeek === where.gymId_dayOfWeek.dayOfWeek) ?? null;
            },
          };
          this.gymSlotPrice = {
            findMany: async () => { calls.push('prices'); await arrive(); return PRICES; },
            findUnique: async ({ where }) => {
              calls.push('priceOne');
              await arrive();
              return PRICES.find((p) => p.startTime === where.gymId_startTime.startTime) ?? null;
            },
          };
          this.slotBlock = {
            findMany: async ({ where }) => {
              calls.push(where.date && typeof where.date === 'object' ? 'blocksRange' : 'blocksDate');
              await arrive();
              return blocks.filter((b) => {
                if (b.gymId !== where.gymId) return false;
                if (typeof where.date === 'string') return b.date === where.date;
                if (where.date && typeof where.date === 'object') return b.date >= where.date.gte && b.date <= where.date.lte;
                return true;
              });
            },
          };
          this.gymReview = {
            findMany: async (args) => {
              reviewFindArgs.push(args);
              calls.push('reviews');
              await arrive();
              const rows = [...reviews].sort((a, b) => b.createdAt - a.createdAt);
              return args.take ? rows.slice(0, args.take) : rows;
            },
          };
        }
      },
    },
  });
  mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  mock.module(new URL('../utils/analytics.js', import.meta.url).href, {
    exports: { track: () => {} },
  });

  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith(BOOKING_HOST)) return realFetch(url, opts);
    bookingCalls.push(u);
    const parsed = new URL(u);
    if (bookingMode === 'down') throw new Error('booking-service down');
    const json = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (parsed.pathname.endsWith('/range')) {
      if (bookingMode === 'noRange') return { ok: false, status: 404, json: async () => ({}) };
      return json(rangeCounts);
    }
    // per-day route
    perDayInflight += 1;
    perDayMaxInflight = Math.max(perDayMaxInflight, perDayInflight);
    await new Promise((r) => setTimeout(r, 5));
    perDayInflight -= 1;
    return json(rangeCounts[parsed.searchParams.get('date')] || {});
  };

  const { default: routes } = await import('../routes/gym.js');
  const app = express();
  app.use('/', routes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
});

function istDates(n) {
  const istNow = new Date(Date.now() + (5 * 60 + 30) * 60000);
  const anchor = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  return Array.from({ length: n }, (_, i) => new Date(anchor + i * 86400000).toISOString().split('T')[0]);
}

beforeEach(() => {
  dates = istDates(7);
  blocks = [];
  reviews = [];
  calls = [];
  gymFindArgs = [];
  reviewFindArgs = [];
  barrier = null;
  barrierIncludesGym = false;
  bookingMode = 'range';
  rangeCounts = {};
  bookingCalls = [];
  perDayInflight = 0;
  perDayMaxInflight = 0;
});

const INTERNAL = { 'x-internal-key': 'slots-test-key' };
async function get(path, headers = {}) {
  const r = await realFetch(`${baseUrl}${path}`, { headers });
  return { status: r.status, body: await r.json() };
}

// ---- reference: the previous per-day implementation -----------------------
async function reference(date, includeUnbookable) {
  const { generateWindowedSlots } = await import('../utils/slots.js');
  const { getDayOfWeek, isSlotInPastOrTooSoon } = await import('../utils/slotTiming.js');
  const hours = HOURS.find((h) => h.dayOfWeek === getDayOfWeek(date));
  const priceMap = new Map(PRICES.map((p) => [p.startTime, Number(p.price)]));
  const blocked = new Set(blocks.filter((b) => b.date === date).map((b) => b.startTime));
  const counts = rangeCounts[date] || {};
  return generateWindowedSlots(hours, GYM.slotDuration)
    .map((s) => ({ ...s, price: priceMap.has(s.startTime) ? priceMap.get(s.startTime) : GYM.sessionPrice }))
    .filter((s) => !blocked.has(s.startTime))
    .map((s) => {
      const booked = counts[s.startTime] || 0;
      const available = Math.max(GYM.capacity - booked, 0);
      const bookable = !isSlotInPastOrTooSoon(date, s.startTime);
      return { ...s, booked, available, bookable, ...(bookable ? {} : { unbookableReason: 'LEAD_TIME' }) };
    })
    .filter((s) => s.available > 0)
    .filter((s) => includeUnbookable || s.bookable);
}

function seedWorld() {
  blocks = [
    { gymId: 1, date: dates[1], startTime: '07:00' },
    { gymId: 1, date: dates[2], startTime: '06:00' },
    { gymId: 1, date: dates[2], startTime: '07:00' },
    { gymId: 1, date: dates[2], startTime: '08:00' },
    { gymId: 1, date: dates[2], startTime: '17:00' },
    { gymId: 1, date: dates[2], startTime: '18:00' }, // whole day blocked
    { gymId: 2, date: dates[3], startTime: '06:00' }, // other gym — ignored
  ];
  rangeCounts = {
    [dates[1]]: { '06:00': 3, '08:00': 1 },
    [dates[3]]: { '06:00': 3, '07:00': 3, '08:00': 3, '17:00': 3, '18:00': 3 }, // full
    [dates[4]]: { '17:00': 2 },
  };
}

// ---- A: internal blocks route ---------------------------------------------
test('internal blocks route returns a gym+date\'s blocks to requireInternal callers', async () => {
  blocks = [
    { id: 1, gymId: 1, date: '2030-01-05', startTime: '07:00', endTime: '08:00' },
    { id: 2, gymId: 1, date: '2030-01-06', startTime: '09:00', endTime: '10:00' },
  ];
  const r = await get('/internal/blocks/1?date=2030-01-05', INTERNAL);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { data: [blocks[0]] });
  const all = await get('/internal/blocks/1', INTERNAL);
  assert.equal(all.body.data.length, 2, 'date is optional, same as the partner route');
});

test('internal blocks route rejects callers without the internal key', async () => {
  assert.equal((await get('/internal/blocks/1?date=2030-01-05')).status, 403);
  assert.equal((await get('/internal/blocks/1?date=2030-01-05', { 'x-internal-key': 'wrong' })).status, 403);
  // user headers alone are not enough
  assert.equal((await get('/internal/blocks/1', { 'x-user-id': '9', 'x-user-role': 'partner' })).status, 403);
});

test('partner blocks route is unchanged: internal key alone is rejected (the original bug), partner headers work', async () => {
  assert.equal((await get('/1/blocks?date=2030-01-05', INTERNAL)).status, 401);
  assert.equal((await get('/1/blocks?date=2030-01-05', { 'x-user-id': '9', 'x-user-role': 'customer' })).status, 403);
  assert.equal((await get('/1/blocks?date=2030-01-05', { 'x-user-id': '9', 'x-user-role': 'partner' })).status, 200);
});

// ---- C: slots --------------------------------------------------------------
test('getGymSlots: output matches the reference, gym read is narrow, four reads start together', async () => {
  seedWorld();
  for (const idx of [0, 1, 2, 3, 4]) {
    for (const includeUnbookable of [false, true]) {
      calls = []; gymFindArgs = [];
      barrier = makeBarrier(4); // hours + prices + blocks + booking counts
      const wrapped = includeUnbookable ? '&includeUnbookable=true' : '';
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (u, o) => { if (String(u).startsWith(BOOKING_HOST)) await arrive(); return origFetch(u, o); };
      const r = await get(`/1/slots?date=${dates[idx]}${wrapped}`);
      globalThis.fetch = origFetch;
      assert.equal(r.status, 200);
      assert.equal(barrier.reached, true, 'hours/prices/blocks/counts were issued together, not serially');
      assert.deepEqual(r.body.data.slots, await reference(dates[idx], includeUnbookable), `date idx ${idx}`);
      assert.equal(r.body.data.capacity, 3);
      assert.equal(typeof r.body.data.leadTimeMinutes, 'number');
      assert.deepEqual(Object.keys(gymFindArgs[0].select).sort(),
        ['capacity', 'isActive', 'isApproved', 'marketplaceEnabled', 'sessionPrice', 'slotDuration']);
      assert.equal(gymFindArgs[0].include, undefined, 'no images/reviews on the slot path');
    }
  }
});

test('getGymSlots: unknown/hidden gym still 404; booking-service down still renders slots', async () => {
  GYM.isApproved = false;
  try { assert.equal((await get(`/1/slots?date=${dates[1]}`)).status, 404); } finally { GYM.isApproved = true; }
  GYM.marketplaceEnabled = false;
  try { assert.equal((await get(`/1/slots?date=${dates[1]}`)).status, 404); } finally { GYM.marketplaceEnabled = true; }
  bookingMode = 'down';
  seedWorld();
  rangeCounts = {};
  const r = await get(`/1/slots?date=${dates[5]}&includeUnbookable=true`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.slots, await reference(dates[5], true));
});

// ---- C: availability -------------------------------------------------------
test('getGymAvailability: identical to the per-day reference; day-invariant work done once', async () => {
  seedWorld();
  const r = await get('/1/availability');
  assert.equal(r.status, 200);
  const expected = [];
  for (const date of dates) {
    const slots = await reference(date, true);
    expected.push({ date, available: slots.some((s) => s.bookable), hasSlots: slots.length > 0 });
  }
  assert.deepEqual(r.body.data.dates, expected);
  assert.equal(calls.filter((c) => c === 'hoursAll').length, 1);
  assert.equal(calls.filter((c) => c === 'prices').length, 1);
  assert.equal(calls.filter((c) => c === 'blocksRange').length, 1);
  assert.equal(calls.filter((c) => c === 'blocksDate').length, 0);
  assert.equal(calls.filter((c) => c === 'hoursOne').length, 0);
  assert.equal(bookingCalls.length, 1, 'one batch slot-count call');
  assert.match(bookingCalls[0], new RegExp(`/internal/slot-counts/1/range\\?from=${dates[0]}&to=${dates[6]}`));
  // sanity: the fixture exercises both outcomes
  assert.ok(expected.some((d) => d.hasSlots === false), 'a fully blocked/closed day exists');
});

test('getGymAvailability: days param is capped at 30', async () => {
  seedWorld();
  dates = istDates(30);
  const r = await get('/1/availability?days=99');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.dates.length, 30);
  assert.equal(r.body.data.dates[29].date, dates[29]);
});

test('getGymAvailability: older booking-service without the range route falls back to capped per-day calls', async () => {
  seedWorld();
  bookingMode = 'noRange';
  const r = await get('/1/availability?days=14');
  assert.equal(r.status, 200);
  dates = istDates(14);
  const expected = [];
  for (const date of dates) {
    const slots = await reference(date, true);
    expected.push({ date, available: slots.some((s) => s.bookable), hasSlots: slots.length > 0 });
  }
  assert.deepEqual(r.body.data.dates, expected);
  const perDay = bookingCalls.filter((u) => !u.includes('/range'));
  assert.equal(perDay.length, 14);
  assert.ok(perDayMaxInflight > 1 && perDayMaxInflight <= 5, `concurrency ${perDayMaxInflight} within (1,5]`);
});

test('getGymAvailability: booking-service down degrades to all-open without per-day retries', async () => {
  seedWorld();
  rangeCounts = {};
  bookingMode = 'down';
  const r = await get('/1/availability');
  assert.equal(r.status, 200);
  assert.equal(bookingCalls.length, 1);
  const expected = [];
  for (const date of dates) {
    const slots = await reference(date, true);
    expected.push({ date, available: slots.some((s) => s.bookable), hasSlots: slots.length > 0 });
  }
  assert.deepEqual(r.body.data.dates, expected);
});

// ---- D: gym detail / reviews / internal -----------------------------------
test('getGym: reviews are capped to the 10 most recent; shape stays an array; aggregates untouched', async () => {
  reviews = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, gymId: 1, rating: 4, createdAt: new Date(2026, 0, i + 1) }));
  const r = await get('/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reviews.length, 10);
  assert.deepEqual(r.body.data.reviews.map((x) => x.id), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
  assert.deepEqual(reviewFindArgs, [], 'reviews ride inside the gym include, not a second query');
  assert.deepEqual(gymFindArgs[0].include.reviews, { orderBy: { createdAt: 'desc' }, take: 10 });
  assert.equal(r.body.data.rating, 4.5);
  assert.equal(r.body.data.ratingCount, 40);
});

test('getGymReviews: gym check and review query run together; hidden gym still 404', async () => {
  reviews = [{ id: 1, gymId: 1, rating: 5, createdAt: new Date(2026, 0, 1) }, { id: 2, gymId: 1, rating: 3, createdAt: new Date(2026, 0, 2) }];
  barrier = makeBarrier(2);
  barrierIncludesGym = true; // gym visibility read + reviews read
  const r = await get('/1/reviews');
  assert.equal(r.status, 200);
  assert.equal(barrier.reached, true);
  assert.deepEqual(r.body.data.map((x) => x.id), [2, 1]);
  GYM.isActive = false;
  try { assert.equal((await get('/1/reviews')).status, 404); } finally { GYM.isActive = true; }
});

test('internal gym fetch: slot price and operating hours looked up together, same result', async () => {
  barrier = makeBarrier(2);
  const date = dates.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0);
  const r = await get(`/internal/1?startTime=06:00&date=${date}`, INTERNAL);
  assert.equal(r.status, 200);
  assert.equal(barrier.reached, true);
  assert.equal(r.body.data.resolvedSlotPrice, 300);
  assert.equal(r.body.data.isValidSlot, true);
  const off = await get(`/internal/1?startTime=12:00&date=${date}`, INTERNAL);
  assert.equal(off.body.data.resolvedSlotPrice, 200, 'falls back to sessionPrice');
  assert.equal(off.body.data.isValidSlot, false);
  const plain = await get('/internal/1', INTERNAL);
  assert.equal(plain.body.data.resolvedSlotPrice, 200);
  assert.equal('isValidSlot' in plain.body.data, false);
});
