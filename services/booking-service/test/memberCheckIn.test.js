// Covers QA test plan Section C (member check-in core flow), D1/D6 (coin
// crediting + idempotent notify), and getMemberAttendance. Run with:
//   node --experimental-test-module-mocks --test
//
// bookingService.js, axios, googleIdToken and notifyChallengeService are
// each mocked ONCE for this file (not re-imported with a cache-busting
// query string per test) — see coinEconomyConfigService's test header
// comment in the challenge-service repo for why.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GYM = { id: 9, lat: 28.4595, lng: 77.0266, city: 'Gurugram', name: 'Test Gym' };
const GYM_NO_COORDS = { id: 77, city: 'Gurugram', name: 'No-coords Gym' }; // lat/lng missing entirely

function metersToLatOffset(meters) {
  return meters / 111_320; // ~ meters per degree latitude
}

// Mutable state each test configures before calling the SUT.
let user;
let axiosGymOverride = null; // when set, /internal/<gymId> returns this instead of GYM lookup by id
let gymLookupThrows = false;
let userLookupThrows = false;
const memberAttendanceRows = new Map(); // `${customerId}|${gymId}|${date}` -> row
let notifyCalls = [];
let nextAttendanceId = 1;

function resetFakes() {
  user = { id: 1, linkedGymId: GYM.id };
  axiosGymOverride = null;
  gymLookupThrows = false;
  userLookupThrows = false;
  memberAttendanceRows.clear();
  notifyCalls = [];
  nextAttendanceId = 1;
}

let memberCheckIn, getMemberAttendance;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.memberAttendance = {
            findUnique: async ({ where: { customerId_gymId_date: k } }) =>
              memberAttendanceRows.get(`${k.customerId}|${k.gymId}|${k.date}`) ?? null,
            create: async ({ data }) => {
              const row = { id: nextAttendanceId++, checkedInAt: new Date('2026-08-27T06:00:00Z'), ...data };
              memberAttendanceRows.set(`${data.customerId}|${data.gymId}|${data.date}`, row);
              return row;
            },
            findFirst: async () => null, // badge check inside emitMemberAttendanceSignals — not under test here
            findMany: async ({ where: { customerId } }) =>
              [...memberAttendanceRows.values()].filter((r) => r.customerId === customerId),
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
          const isGymLookup = url.includes(`/internal/${GYM.id}`) || url.includes(`/internal/${GYM_NO_COORDS.id}`) || axiosGymOverride;
          if (!isGymLookup) {
            // auth-service internal user profile lookup
            if (userLookupThrows || !user) throw { response: { status: 404 } };
            return { data: { data: user } };
          }
          if (gymLookupThrows) throw { response: { status: 404 } };
          if (axiosGymOverride) return { data: { data: axiosGymOverride } };
          if (url.includes(`/internal/${GYM.id}`)) return { data: { data: GYM } };
          if (url.includes(`/internal/${GYM_NO_COORDS.id}`)) return { data: { data: GYM_NO_COORDS } };
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

  ({ memberCheckIn, getMemberAttendance } = await import('../services/bookingService.js'));
  assert.equal(typeof memberCheckIn, 'function');
});

test('customer profile lookup fails entirely -> User not found', async () => {
  resetFakes();
  userLookupThrows = true;
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, GYM.lat, GYM.lng),
    (err) => { assert.equal(err.status, 404); assert.equal(err.error, 'User not found'); return true; }
  );
});

test('customer with no linkedGymId -> NOT_LINKED_GYM', async () => {
  resetFakes();
  user = { id: 1, linkedGymId: null };
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, GYM.lat, GYM.lng),
    (err) => { assert.equal(err.status, 403); assert.equal(err.code, 'NOT_LINKED_GYM'); return true; }
  );
});

test('customer linked to a DIFFERENT gym -> NOT_LINKED_GYM', async () => {
  resetFakes();
  user = { id: 1, linkedGymId: 12345 };
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, GYM.lat, GYM.lng),
    (err) => { assert.equal(err.code, 'NOT_LINKED_GYM'); return true; }
  );
});

test('missing lat/lng -> LOCATION_REQUIRED', async () => {
  resetFakes();
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, undefined, undefined),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'LOCATION_REQUIRED'); return true; }
  );
});

test('non-numeric lat/lng -> LOCATION_REQUIRED', async () => {
  resetFakes();
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, '28.4', '77.0'),
    (err) => { assert.equal(err.code, 'LOCATION_REQUIRED'); return true; }
  );
});

test('gym lookup fails entirely -> Gym not found', async () => {
  resetFakes();
  gymLookupThrows = true;
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, GYM.lat, GYM.lng),
    (err) => { assert.equal(err.status, 404); assert.equal(err.error, 'Gym not found'); return true; }
  );
});

test('gym has no lat/lng on file -> TOO_FAR (withinRange short-circuits false)', async () => {
  resetFakes();
  user = { id: 1, linkedGymId: GYM_NO_COORDS.id };
  await assert.rejects(
    () => memberCheckIn(GYM_NO_COORDS.id, 1, 28.4, 77.0),
    (err) => { assert.equal(err.code, 'TOO_FAR'); return true; }
  );
});

test('correctly linked but >50m away -> TOO_FAR', async () => {
  resetFakes();
  const farLat = GYM.lat + metersToLatOffset(200); // ~200m north
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, farLat, GYM.lng),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'TOO_FAR'); return true; }
  );
});

test('correctly linked, within 50m -> succeeds, creates row, notifies challenge-service once', async () => {
  resetFakes();
  const nearLat = GYM.lat + metersToLatOffset(10); // ~10m north, within the 50m geofence

  const result = await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);

  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(memberAttendanceRows.size, 1);
  assert.equal(notifyCalls.length, 1, 'exactly one attendance event sent to challenge-service');
  assert.equal(notifyCalls[0].source, 'member_checkin');
  assert.equal(notifyCalls[0].idempotencyKey, `member-checkin:${result.attendanceId}`);
});

test('checking in again the same day is idempotent — no duplicate row, no duplicate coin notify', async () => {
  resetFakes();
  const nearLat = GYM.lat + metersToLatOffset(10);

  const first = await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);
  const second = await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);

  assert.equal(second.alreadyCheckedIn, true);
  assert.equal(second.attendanceId, first.attendanceId);
  assert.equal(memberAttendanceRows.size, 1, 'no duplicate MemberAttendance row created');
  assert.equal(notifyCalls.length, 1, 'the second (duplicate) check-in must NOT fire a second coin-notify call');
});

test('getMemberAttendance returns an empty list for a customer with no check-ins (skips gym-name lookup entirely)', async () => {
  resetFakes();
  const records = await getMemberAttendance(1);
  assert.deepEqual(records, []);
});

test('getMemberAttendance resolves gym names for each record', async () => {
  resetFakes();
  const nearLat = GYM.lat + metersToLatOffset(10);
  await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);

  const records = await getMemberAttendance(1);
  assert.equal(records.length, 1);
  assert.equal(records[0].gymId, GYM.id);
  assert.equal(records[0].gymName, GYM.name);
});

test('getMemberAttendance falls back to gymName: null when gym-name resolution fails (best-effort, does not throw)', async () => {
  resetFakes();
  const nearLat = GYM.lat + metersToLatOffset(10);
  await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);
  gymLookupThrows = true; // now make the gym-name lookup inside getMemberAttendance fail

  const records = await getMemberAttendance(1);
  assert.equal(records.length, 1);
  assert.equal(records[0].gymName, null);
});
