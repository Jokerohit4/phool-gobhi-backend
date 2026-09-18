// Non-partner gym check-in (bookingService.independentCheckIn). Run with:
//   node --experimental-test-module-mocks --test
//
// Same mock-once-per-file convention as memberCheckIn.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GYM = { id: 5, name: 'Independent Iron', lat: 28.4595, lng: 77.0266 };
const GYM_NO_COORDS = { id: 6, name: 'Pinless Gym' };

function metersToLatOffset(meters) {
  return meters / 111_320;
}

let gymLookupThrows = false;
let gymOverride = null;
const rows = new Map(); // `${customerId}|${unclaimedGymId}|${date}` -> row
let notifyCalls = [];
let trackCalls = [];
let nextId = 1;
// Set to make the next create() collide, standing in for two taps racing.
let createRaces = false;

function key(c, g, d) {
  return `${c}|${g}|${d}`;
}

function resetFakes() {
  gymLookupThrows = false;
  gymOverride = null;
  rows.clear();
  notifyCalls = [];
  trackCalls = [];
  nextId = 1;
  createRaces = false;
}

let independentCheckIn, listIndependentCheckIns;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.independentCheckIn = {
            findUnique: async ({ where: { customerId_unclaimedGymId_date: k } }) =>
              rows.get(key(k.customerId, k.unclaimedGymId, k.date)) ?? null,
            create: async ({ data }) => {
              const k = key(data.customerId, data.unclaimedGymId, data.date);
              if (createRaces || rows.has(k)) {
                // Mirrors Prisma's unique-constraint violation.
                if (createRaces) {
                  createRaces = false;
                  rows.set(k, { id: nextId++, checkedInAt: new Date('2026-09-18T06:00:00Z'), ...data });
                }
                throw { code: 'P2002' };
              }
              const row = { id: nextId++, checkedInAt: new Date('2026-09-18T06:00:00Z'), ...data };
              rows.set(k, row);
              return row;
            },
            findMany: async ({ where: { customerId } }) =>
              [...rows.values()].filter((r) => r.customerId === customerId),
          };
          this.booking = { findFirst: async () => null };
        }
      },
      Prisma: {},
    },
  });

  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url) => {
          if (gymLookupThrows) throw { response: { status: 404 } };
          if (gymOverride) return { data: { data: gymOverride } };
          if (url.includes('/internal/unclaimed-gyms/5')) return { data: { data: GYM } };
          if (url.includes('/internal/unclaimed-gyms/6')) return { data: { data: GYM_NO_COORDS } };
          throw new Error(`unexpected axios.get(${url})`);
        },
      },
    },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: { recordAttendanceEvent: async (args) => { notifyCalls.push(args); } },
  });

  t.mock.module(new URL('../utils/analytics.js', import.meta.url).href, {
    exports: { track: (...args) => { trackCalls.push(args); } },
  });

  ({ independentCheckIn, listIndependentCheckIns } = await import('../services/bookingService.js'));
  assert.equal(typeof independentCheckIn, 'function');
});

test('inside the geofence records the check-in and emits one attendance event', async () => {
  resetFakes();
  const res = await independentCheckIn(1, GYM.id, GYM.lat, GYM.lng);

  assert.equal(res.alreadyCheckedIn, false);
  assert.equal(res.checkIn.customerId, 1);
  assert.equal(res.checkIn.unclaimedGymId, GYM.id);
  assert.equal(notifyCalls.length, 1);

  const evt = notifyCalls[0];
  // gymId here is an UnclaimedGym id — `source` is the only thing telling a
  // later reader which table to resolve it against, so it has to be exact.
  assert.equal(evt.source, 'independent_gym_geofence');
  assert.equal(evt.gymId, GYM.id);
  assert.equal(evt.bookingId, null);
  assert.equal(evt.memberAttendanceId, null);
  assert.ok(evt.idempotencyKey);
});

test('coordinates are never persisted', async () => {
  // booking-service is deliberately excluded from the DPDPA erasure fan-out
  // on the grounds that it holds no PII. A stored GPS fix would quietly make
  // that untrue, so this is a guard on that property, not a detail.
  resetFakes();
  const res = await independentCheckIn(1, GYM.id, GYM.lat, GYM.lng);
  assert.equal(res.checkIn.lat, undefined);
  assert.equal(res.checkIn.lng, undefined);
});

test('outside the geofence is refused with TOO_FAR and records nothing', async () => {
  resetFakes();
  await assert.rejects(
    () => independentCheckIn(1, GYM.id, GYM.lat + metersToLatOffset(400), GYM.lng),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'TOO_FAR');
      // The gym's name belongs in the message — "you need to be at the gym"
      // is confusing when the user believes they are at a gym.
      assert.match(err.error, /Independent Iron/);
      return true;
    }
  );
  assert.equal(rows.size, 0);
  assert.equal(notifyCalls.length, 0);
});

test('just inside the radius is accepted', async () => {
  resetFakes();
  const res = await independentCheckIn(1, GYM.id, GYM.lat + metersToLatOffset(290), GYM.lng);
  assert.equal(res.alreadyCheckedIn, false);
});

test('a second check-in the same day is a no-op, not an error', async () => {
  // People re-open the app and tap again when the first tap looked slow.
  // Treating that as a failure would be wrong, and double-counting it would
  // inflate a streak.
  resetFakes();
  await independentCheckIn(1, GYM.id, GYM.lat, GYM.lng);
  const second = await independentCheckIn(1, GYM.id, GYM.lat, GYM.lng);

  assert.equal(second.alreadyCheckedIn, true);
  assert.equal(rows.size, 1);
  assert.equal(notifyCalls.length, 1, 'no second attendance event');
});

test('two taps racing each other resolve to one check-in', async () => {
  resetFakes();
  createRaces = true;
  const res = await independentCheckIn(1, GYM.id, GYM.lat, GYM.lng);
  assert.equal(res.alreadyCheckedIn, true);
  assert.equal(rows.size, 1);
  assert.equal(notifyCalls.length, 0, 'the losing side must not emit an event');
});

test('a gym with no coordinates cannot be checked into', async () => {
  resetFakes();
  await assert.rejects(
    () => independentCheckIn(1, GYM_NO_COORDS.id, 28.4595, 77.0266),
    (err) => { assert.equal(err.code, 'LOCATION_REQUIRED'); return true; }
  );
});

test('missing device coordinates are refused', async () => {
  resetFakes();
  await assert.rejects(
    () => independentCheckIn(1, GYM.id, NaN, NaN),
    (err) => { assert.equal(err.code, 'LOCATION_REQUIRED'); return true; }
  );
});

test('an unknown gym is a 404', async () => {
  resetFakes();
  gymLookupThrows = true;
  await assert.rejects(
    () => independentCheckIn(1, 999, GYM.lat, GYM.lng),
    (err) => { assert.equal(err.status, 404); return true; }
  );
});

test('history is scoped to the requesting customer', async () => {
  resetFakes();
  await independentCheckIn(1, GYM.id, GYM.lat, GYM.lng);
  await independentCheckIn(2, GYM.id, GYM.lat, GYM.lng);

  const mine = await listIndependentCheckIns(1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].customerId, 1);
});
