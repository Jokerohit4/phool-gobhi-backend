// Cursor pagination for GET /bookings/mine (getCustomerBookingsPage + getMyBookings
// controller): page size and meta, walking cursors to the end, exact boundaries
// with identical createdAt, limit clamping, unchanged item shape, and gym
// enrichment restricted to the page's gyms.
// Same mock-once-per-file convention as gymCardCache.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const CUSTOMER = 1;
let bookingRows = [];
let gymCalls = [];
let lastArgs;
let svc;
let ctl;

function fakeFindMany(args) {
  lastArgs = args;
  let list = bookingRows.filter((r) => r.customerId === args.where.customerId);
  const order = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
  list = [...list].sort((a, b) => {
    for (const o of order) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k] instanceof Date ? a[k].getTime() : a[k];
      const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (av !== bv) return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
  let start = 0;
  if (args.cursor) {
    const idx = list.findIndex((r) => r.id === args.cursor.id);
    start = idx === -1 ? list.length : idx;
  }
  start += args.skip || 0;
  return Promise.resolve(list.slice(start, start + args.take));
}

test('setup: mock dependencies once, import bookingService + controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class { constructor() { this.booking = { findMany: fakeFindMany }; } },
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    },
  });
  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url) => {
          const id = Number(new URL(url).pathname.split('/').pop());
          gymCalls.push(id);
          return { data: { data: { id, name: `Gym ${id}`, address: 'A', city: 'X', images: [{ url: `img${id}` }] } } };
        },
        post: async () => ({ data: {} }),
      },
    },
  });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module(new URL('../utils/notifyPartner.js', import.meta.url).href, {
    exports: { notifyPartner: async () => {}, sendPartnerPush: async () => true, resolvePartnerFcmToken: async () => null },
  });
  t.mock.module(new URL('../utils/notifyCustomer.js', import.meta.url).href, { exports: { notifyCustomer: async () => {} } });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, { exports: { recordAttendanceEvent: async () => {} } });
  t.mock.module(new URL('../utils/notifyHealthService.js', import.meta.url).href, { exports: { recordAttendanceForWorkout: async () => {} } });
  svc = await import('../services/bookingService.js');
  ctl = await import('../controllers/bookingController.js');
});

function seed(n, { same = false, gymOf = () => 10 } = {}) {
  svc._resetGymCardCache();
  gymCalls = [];
  bookingRows = [];
  for (let i = 1; i <= n; i++) {
    bookingRows.push({
      id: i, customerId: CUSTOMER, gymId: gymOf(i), date: '2026-09-14', startTime: '10:00', endTime: '11:00',
      amount: 500, commissionPct: 20, partnerShare: 400, status: 'completed', subscriptionId: null,
      createdAt: same ? new Date('2026-09-01T00:00:00Z') : new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
      updatedAt: new Date(),
    });
  }
  bookingRows.push({ id: 9000, customerId: 2, gymId: 10, status: 'completed', createdAt: new Date(), updatedAt: new Date() });
}

async function walk(limit) {
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard++) {
    const { items, meta } = await svc.getCustomerBookingsPage(CUSTOMER, { limit, cursor });
    pages.push({ ids: items.map((b) => b.id), meta });
    if (!meta.hasMore) break;
    cursor = meta.nextCursor;
  }
  return pages;
}

function mkRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('first page: size = limit, meta, createdAt desc + id desc, limit+1 fetched', async () => {
  seed(12);
  const { items, meta } = await svc.getCustomerBookingsPage(CUSTOMER, { limit: 5 });
  assert.deepEqual(items.map((b) => b.id), [12, 11, 10, 9, 8]);
  assert.deepEqual(meta, { nextCursor: 8, hasMore: true });
  assert.equal(lastArgs.take, 6);
  assert.deepEqual(lastArgs.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(lastArgs.cursor, undefined);
});

test('following the cursor to the end visits every row once; last page hasMore false', async () => {
  seed(12);
  const pages = await walk(5);
  assert.deepEqual(pages.map((p) => p.ids), [[12, 11, 10, 9, 8], [7, 6, 5, 4, 3], [2, 1]]);
  assert.deepEqual(pages[2].meta, { nextCursor: null, hasMore: false });
  assert.deepEqual(lastArgs.cursor, { id: 3 });
  assert.equal(lastArgs.skip, 1);
});

test('exact boundary: total == limit and total == 2*limit give no empty trailing page', async () => {
  seed(5);
  assert.equal((await walk(5)).length, 1);
  seed(10);
  const pages = await walk(5);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1].meta, { nextCursor: null, hasMore: false });
});

test('identical createdAt: id tiebreak keeps pages disjoint and complete', async () => {
  seed(11, { same: true });
  const all = (await walk(4)).flatMap((p) => p.ids);
  assert.deepEqual(all, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test('item shape unchanged: commercial split stripped, gym + qrToken attached', async () => {
  seed(2);
  const { items } = await svc.getCustomerBookingsPage(CUSTOMER, { limit: 50 });
  const b = items[0];
  assert.equal(b.id, 2);
  assert.equal(b.commissionPct, undefined);
  assert.equal(b.partnerShare, undefined);
  assert.equal(b.amount, 500);
  assert.equal(b.gym.name, 'Gym 10');
  assert.ok(typeof b.qrToken === 'string' && b.qrToken.length > 0);
});

test('only the page\'s gyms are enriched', async () => {
  seed(6, { gymOf: (i) => 100 + i }); // ids 6..1 -> gyms 106..101
  await svc.getCustomerBookingsPage(CUSTOMER, { limit: 2 });
  assert.deepEqual([...gymCalls].sort(), [105, 106]);
});

test('legacy getCustomerBookings still returns a plain array (first page)', async () => {
  seed(3);
  const out = await svc.getCustomerBookings(CUSTOMER);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 3);
});

test('controller: default 50, {data, meta}; cursor continues; clamping 0/-1/abc -> 50, 5000 -> 100', async () => {
  seed(120);
  const res = mkRes();
  await ctl.getMyBookings({ userId: CUSTOMER, query: {} }, res);
  assert.equal(res.body.data.length, 50);
  assert.deepEqual(res.body.meta, { nextCursor: res.body.data[49].id, hasMore: true });

  const res2 = mkRes();
  await ctl.getMyBookings({ userId: CUSTOMER, query: { cursor: String(res.body.meta.nextCursor), limit: '100' } }, res2);
  assert.equal(res2.body.data.length, 70);
  assert.deepEqual(res2.body.meta, { nextCursor: null, hasMore: false });

  for (const [raw, expected] of [['0', 50], ['-1', 50], ['abc', 50], ['5000', 100], ['7', 7]]) {
    const r = mkRes();
    await ctl.getMyBookings({ userId: CUSTOMER, query: { limit: raw } }, r);
    assert.equal(r.body.data.length, expected, `limit=${raw}`);
  }
});
