// Covers QA test plan Section C (member check-in core flow) and D1/D6
// (coin crediting + idempotent notify). Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GYM = { id: 9, lat: 28.4595, lng: 77.0266, city: 'Gurugram', name: 'Test Gym' }; // Gurugram coords

function metersToLatOffset(meters) {
  return meters / 111_320; // ~ meters per degree latitude
}

function mockEverything(t, { user, memberAttendanceRows = new Map(), notifyCalls = [] } = {}) {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.memberAttendance = {
            findUnique: async ({ where: { customerId_gymId_date: k } }) =>
              memberAttendanceRows.get(`${k.customerId}|${k.gymId}|${k.date}`) ?? null,
            create: async ({ data }) => {
              const row = { id: memberAttendanceRows.size + 1, checkedInAt: new Date('2026-08-27T06:00:00Z'), ...data };
              memberAttendanceRows.set(`${data.customerId}|${data.gymId}|${data.date}`, row);
              return row;
            },
            // Used by hasPriorVisitAtGym's badge check inside
            // emitMemberAttendanceSignals — not under test here, so "no
            // prior visits" is a fine constant answer.
            findFirst: async () => null,
          };
          this.booking = { findFirst: async () => null }; // no prior booking visits in these tests
        }
      },
      Prisma: {},
    },
  });

  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url) => {
          if (url.includes('/internal/') && !url.includes(String(GYM.id))) {
            // auth-service internal user profile lookup
            if (!user) throw { response: { status: 404 } };
            return { data: { data: user } };
          }
          if (url.includes(`/internal/${GYM.id}`)) {
            return { data: { data: GYM } };
          }
          throw new Error(`unexpected axios.get(${url})`);
        },
      },
    },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: {
      recordAttendanceEvent: async (args) => {
        notifyCalls.push(args);
      },
    },
  });

  return { memberAttendanceRows, notifyCalls };
}

async function freshBookingService() {
  return import(`../services/bookingService.js?t=${Math.random().toString(36).slice(2)}`);
}

test('customer with no linkedGymId -> NOT_LINKED_GYM', async (t) => {
  mockEverything(t, { user: { id: 1, linkedGymId: null } });
  const { memberCheckIn } = await freshBookingService();
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, GYM.lat, GYM.lng),
    (err) => { assert.equal(err.status, 403); assert.equal(err.code, 'NOT_LINKED_GYM'); return true; }
  );
});

test('customer linked to a DIFFERENT gym -> NOT_LINKED_GYM', async (t) => {
  mockEverything(t, { user: { id: 1, linkedGymId: 12345 } });
  const { memberCheckIn } = await freshBookingService();
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, GYM.lat, GYM.lng),
    (err) => { assert.equal(err.code, 'NOT_LINKED_GYM'); return true; }
  );
});

test('missing lat/lng -> LOCATION_REQUIRED', async (t) => {
  mockEverything(t, { user: { id: 1, linkedGymId: GYM.id } });
  const { memberCheckIn } = await freshBookingService();
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, undefined, undefined),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'LOCATION_REQUIRED'); return true; }
  );
});

test('correctly linked but >50m away -> TOO_FAR', async (t) => {
  mockEverything(t, { user: { id: 1, linkedGymId: GYM.id } });
  const { memberCheckIn } = await freshBookingService();
  const farLat = GYM.lat + metersToLatOffset(200); // ~200m north
  await assert.rejects(
    () => memberCheckIn(GYM.id, 1, farLat, GYM.lng),
    (err) => { assert.equal(err.status, 400); assert.equal(err.code, 'TOO_FAR'); return true; }
  );
});

test('correctly linked, within 50m -> succeeds, creates row, notifies challenge-service once', async (t) => {
  const { notifyCalls, memberAttendanceRows } = mockEverything(t, { user: { id: 1, linkedGymId: GYM.id } });
  const { memberCheckIn } = await freshBookingService();
  const nearLat = GYM.lat + metersToLatOffset(10); // ~10m north, within the 50m geofence

  const result = await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);

  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(memberAttendanceRows.size, 1);
  assert.equal(notifyCalls.length, 1, 'exactly one attendance event sent to challenge-service');
  assert.equal(notifyCalls[0].source, 'member_checkin');
  assert.equal(notifyCalls[0].idempotencyKey, `member-checkin:${result.attendanceId}`);
});

test('checking in again the same day is idempotent — no duplicate row, no duplicate coin notify', async (t) => {
  const { notifyCalls, memberAttendanceRows } = mockEverything(t, { user: { id: 1, linkedGymId: GYM.id } });
  const { memberCheckIn } = await freshBookingService();
  const nearLat = GYM.lat + metersToLatOffset(10);

  const first = await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);
  const second = await memberCheckIn(GYM.id, 1, nearLat, GYM.lng);

  assert.equal(second.alreadyCheckedIn, true);
  assert.equal(second.attendanceId, first.attendanceId);
  assert.equal(memberAttendanceRows.size, 1, 'no duplicate MemberAttendance row created');
  assert.equal(notifyCalls.length, 1, 'the second (duplicate) check-in must NOT fire a second coin-notify call');
});
