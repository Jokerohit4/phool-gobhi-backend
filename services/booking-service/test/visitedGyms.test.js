// E4 endpoint contract fixtures. Real router/controller/projection; in-memory
// Prisma reads and gym-service HTTP replies. No live database or gateway.
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.INTERNAL_API_KEY = 'e4-test-key';
const bookings = [];
const members = [];
const independent = [];
const metadata = new Map();
const queries = [];
const lookups = [];
const signals = [];
let readError = null;
let server, baseUrl;

function reader(model, rows) {
  return async (args) => {
    queries.push({ model, ...args });
    if (readError) throw readError;
    return rows
      .filter((r) => r.customerId === args.where.customerId)
      .filter((r) => !args.where.attendedAt || r.attendedAt != null)
      .map((r) => Object.fromEntries(Object.keys(args.select).map((key) => [key, r[key]])));
  };
}

before(async () => {
  mock.module('@prisma/client', {
    exports: {
      Prisma: {},
      PrismaClient: class {
        constructor() {
          this.booking = { findMany: reader('booking', bookings) };
          this.memberAttendance = { findMany: reader('member', members) };
          this.independentCheckIn = { findMany: reader('independent', independent) };
        }
      },
    },
  });
  mock.module('axios', { exports: { default: {
    get: async (url, config) => {
      const path = new URL(url).pathname;
      lookups.push({ path, headers: config.headers });
      if (!metadata.has(path)) throw { response: { status: 404 } };
      return { data: metadata.get(path) };
    },
  } } });
  mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({ Authorization: 'Bearer test-token' }) },
  });
  // A recognition read must never emit attendance/workout/analytics signals.
  for (const [file, name] of [
    ['notifyChallengeService', 'recordAttendanceEvent'],
    ['notifyHealthService', 'recordAttendanceForWorkout'],
    ['analytics', 'track'],
  ]) {
    mock.module(new URL(`../utils/${file}.js`, import.meta.url).href, {
      exports: { [name]: (...args) => signals.push({ name, args }) },
    });
  }
  const { default: routes } = await import('../routes/booking.js');
  const app = express();
  app.use('/api/bookings', routes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/bookings/mine/visited-gyms`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  for (const rows of [bookings, members, independent, queries, lookups, signals]) rows.length = 0;
  metadata.clear();
  readError = null;
});
afterEach(() => assert.deepEqual(signals, [], 'projection must remain read-only'));

async function get(query = '', headers = { 'x-user-id': '42', 'x-user-role': 'customer' }) {
  const response = await fetch(`${baseUrl}${query}`, { headers });
  return { status: response.status, body: await response.json() };
}
function booking(gymId, at, extra = {}) {
  bookings.push({ customerId: 42, gymId, attendedAt: at ? new Date(at) : null, ...extra });
}
function member(gymId, date, at = `${date}T06:00:00Z`, extra = {}) {
  members.push({ customerId: 42, gymId, date, checkedInAt: new Date(at), ...extra });
}
function checkin(unclaimedGymId, date, extra = {}) {
  independent.push({ customerId: 42, unclaimedGymId, date, checkedInAt: new Date(`${date}T06:00:00Z`), ...extra });
}
function v1(gymId, firstVisitedAt, visitCount = 1, gym = null) {
  return { gymId, firstVisitedAt, visitCount, gym };
}
function v2(type, id, firstVisitedAt, visitCount = 1, gym = null) {
  return {
    venueId: `${type}:${id}`, unclaimedGymId: type === 'unclaimed' ? id : null,
    ...v1(type === 'partner' ? id : null, firstVisitedAt, visitCount, gym),
  };
}

test('new account returns an empty list in both versions', async () => {
  assert.deepEqual(await get(), { status: 200, body: { data: [] } });
  assert.deepEqual(await get('?version=2'), { status: 200, body: { data: [] } });
  assert.deepEqual(lookups, []);
});

test('linked member with no bookings gets a v1 badge, even after unlinking/check-out', async () => {
  member(7, '2026-10-20', undefined, { checkedOutAt: new Date('2026-10-20T08:00:00Z') });
  const expected = { status: 200, body: { data: [v1(7, '2026-10-20T06:00:00.000Z')] } };
  assert.deepEqual(await get(), expected);
  assert.deepEqual(await get('?version=1'), expected);
  assert.ok(lookups.every((r) => r.path === '/internal/7'));
});

test('independent member is recognized in v2 without putting an unclaimed ID in v1 gymId', async () => {
  checkin(7, '2026-10-20');
  assert.deepEqual(await get(), { status: 200, body: { data: [] } });
  assert.equal(queries.some((q) => q.model === 'independent'), false);
  assert.deepEqual(await get('?version=2'), {
    status: 200, body: { data: [v2('unclaimed', 7, '2026-10-20T06:00:00.000Z')] },
  });
  assert.deepEqual(lookups.map((r) => r.path), ['/internal/unclaimed-gyms/7']);
});

test('same venue through booking and member sources has one badge and distinct visit days', async () => {
  booking(7, '2026-10-20T07:00:00Z');
  member(7, '2026-10-20');
  member(7, '2026-10-21');
  assert.deepEqual(await get(), {
    status: 200, body: { data: [v1(7, '2026-10-20T06:00:00.000Z', 2)] },
  });
  assert.equal(lookups.length, 1, 'one metadata read per venue');
});

test('duplicate rows and repeated same-day sessions/check-ins do not inflate visits', async () => {
  for (let i = 0; i < 3; i++) {
    booking(7, `2026-10-20T0${7 + i}:00:00Z`);
    member(7, '2026-10-20');
    checkin(9, '2026-10-20');
  }
  assert.deepEqual(await get('?version=2'), {
    status: 200, body: { data: [
      v2('partner', 7, '2026-10-20T06:00:00.000Z'),
      v2('unclaimed', 9, '2026-10-20T06:00:00.000Z'),
    ] },
  });
});

test('partner and unclaimed venues with the same numeric ID/name/location remain distinct', async () => {
  member(7, '2026-10-20');
  checkin(7, '2026-10-20');
  const gym = { name: 'Same Gym', lat: 28.4, lng: 77, city: 'Delhi' };
  metadata.set('/internal/7', { data: gym });
  metadata.set('/internal/unclaimed-gyms/7', { data: { ...gym, claimedGymId: 7 } });
  assert.deepEqual(await get('?version=2'), {
    status: 200, body: { data: [
      v2('partner', 7, '2026-10-20T06:00:00.000Z', 1, gym),
      v2('unclaimed', 7, '2026-10-20T06:00:00.000Z', 1, gym),
    ] },
  });
});

test('visit dedupe uses IST midnight and actual booking attendance, not the scheduled date', async () => {
  booking(7, '2026-10-20T18:29:59Z', { date: '2026-10-19' });
  booking(7, '2026-10-20T18:30:00Z', { date: '2026-10-20' });
  member(7, '2026-10-21', '2026-10-20T18:31:00Z');
  assert.deepEqual((await get()).body.data, [v1(7, '2026-10-20T18:29:59.000Z', 2)]);
});

test('only verified bookings count; recognition does not re-evaluate status or verification method', async () => {
  for (const status of ['confirmed', 'completed', 'cancelled', 'pending']) booking(99, null, { status });
  booking(7, '2026-10-20T06:00:00Z', { status: 'started', attendanceMethod: 'qr_scan' });
  booking(8, '2026-10-20T07:00:00Z', { status: 'completed', attendanceMethod: 'manual_override' });
  assert.deepEqual((await get()).body.data, [
    v1(7, '2026-10-20T06:00:00.000Z'), v1(8, '2026-10-20T07:00:00.000Z'),
  ]);
  assert.deepEqual(queries.find((q) => q.model === 'booking').where, {
    customerId: 42, attendedAt: { not: null },
  });
});

test('deleted gym metadata (404) retains real visits from every source', async () => {
  booking(7, '2026-10-20T06:00:00Z');
  member(8, '2026-10-20');
  checkin(9, '2026-10-20');
  assert.deepEqual((await get('?version=2')).body.data, [
    v2('partner', 7, '2026-10-20T06:00:00.000Z'),
    v2('partner', 8, '2026-10-20T06:00:00.000Z'),
    v2('unclaimed', 9, '2026-10-20T06:00:00.000Z'),
  ]);
});

test('explicitly null gym metadata remains null rather than an empty metadata object', async () => {
  member(7, '2026-10-20');
  checkin(9, '2026-10-20');
  metadata.set('/internal/7', { data: null });
  metadata.set('/internal/unclaimed-gyms/9', { data: null });
  assert.deepEqual((await get('?version=2')).body.data, [
    v2('partner', 7, '2026-10-20T06:00:00.000Z'),
    v2('unclaimed', 9, '2026-10-20T06:00:00.000Z'),
  ]);
});

test('metadata supports wrapped/bare responses, preserves partial data, and exposes only v1 fields', async () => {
  member(7, '2026-10-20');
  checkin(9, '2026-10-20');
  metadata.set('/internal/7', { name: 'Partner', lat: 28.4, lng: 77, city: 'Delhi', partnerId: 123 });
  metadata.set('/internal/unclaimed-gyms/9', { data: { name: 'Independent', lat: null, lng: null, city: null, createdBy: 42 } });
  assert.deepEqual((await get('?version=2')).body.data, [
    v2('partner', 7, '2026-10-20T06:00:00.000Z', 1, { name: 'Partner', lat: 28.4, lng: 77, city: 'Delhi' }),
    v2('unclaimed', 9, '2026-10-20T06:00:00.000Z', 1, { name: 'Independent', lat: null, lng: null, city: null }),
  ]);
  for (const lookup of lookups) {
    assert.equal(lookup.headers['x-internal-key'], 'e4-test-key');
    assert.equal(lookup.headers.Authorization, 'Bearer test-token');
  }
});

test('all attendance sources are scoped to the authenticated customer', async () => {
  booking(7, '2026-10-20T06:00:00Z', { customerId: 43 });
  member(8, '2026-10-20', undefined, { customerId: 43 });
  checkin(9, '2026-10-20', { customerId: 43 });
  assert.deepEqual((await get('?version=2')).body, { data: [] });
  assert.equal(queries.length, 3);
  assert.ok(queries.every((q) => q.where.customerId === 42));
});

test('refresh after check-in exposes new visits without persisting or emitting badges', async () => {
  member(7, '2026-10-20');
  assert.equal((await get()).body.data[0].visitCount, 1);
  member(7, '2026-10-21');
  booking(7, '2026-10-21T07:00:00Z');
  assert.equal((await get()).body.data[0].visitCount, 2);
  assert.equal((await get()).body.data[0].visitCount, 2);
});

test('attendance read failure returns 500 rather than an incomplete successful badge list', async (t) => {
  t.mock.method(console, 'error', () => {});
  readError = new Error('attendance unavailable');
  assert.deepEqual(await get('?version=2'), { status: 500, body: { error: 'attendance unavailable' } });
  assert.deepEqual(lookups, []);
});

test('unsupported, ambiguous and malformed versions return 400 before any reads', async () => {
  for (const query of ['?version=3', '?version=', '?version=2x', '?version=1&version=2']) {
    assert.equal((await get(query)).status, 400);
  }
  assert.deepEqual(queries, []);
});

test('endpoint preserves customer authentication and role gates for both versions', async () => {
  for (const query of ['', '?version=2']) {
    assert.equal((await get(query, {})).status, 401);
    assert.equal((await get(query, { 'x-user-id': '42', 'x-user-role': 'partner' })).status, 403);
  }
  assert.deepEqual(queries, []);
});
