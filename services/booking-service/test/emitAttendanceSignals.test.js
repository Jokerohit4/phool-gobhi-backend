// Covers the two badge/coin-signal emitters directly (exported purely for
// testability — they're normally called internally from selfCheckIn/
// verifyAttendance/completeBooking/memberCheckIn, which are large
// pre-existing flows out of scope for this session). Closes the coverage
// gap the other booking-service test files leave: hasPriorVisitAtGym is
// tested directly, and memberCheckIn/getMemberAttendance are tested via
// their public API, but emitAttendanceSignals's badge_earned branches and
// both functions' badge-check-failed catch branches are otherwise
// unreachable without a live DB error. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let bookingResult = null;
let memberAttendanceResult = null;
let throwOnBookingLookup = false;
const notifyCalls = [];

function resetFakes() {
  bookingResult = null;
  memberAttendanceResult = null;
  throwOnBookingLookup = false;
  notifyCalls.length = 0;
}

let emitAttendanceSignals, emitMemberAttendanceSignals;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findFirst: async () => {
              if (throwOnBookingLookup) throw new Error('simulated DB error');
              return bookingResult;
            },
          };
          this.memberAttendance = { findFirst: async () => memberAttendanceResult };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: { recordAttendanceEvent: async (args) => { notifyCalls.push(args); } },
  });

  ({ emitAttendanceSignals, emitMemberAttendanceSignals } = await import('../services/bookingService.js'));
  assert.equal(typeof emitAttendanceSignals, 'function');
});

test('emitAttendanceSignals: first-ever visit -> badge check runs clean, notify always fires', async () => {
  resetFakes();
  await emitAttendanceSignals({ customerId: 1, bookingId: 100, gymId: 9, city: 'Gurugram', source: 'self_checkin' });
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].bookingId, 100);
  assert.equal(notifyCalls[0].idempotencyKey, 'booking:100');
  assert.equal(notifyCalls[0].source, 'self_checkin');
});

test('emitAttendanceSignals: prior visit exists -> notify still fires (badge suppression does not affect the coin/streak signal)', async () => {
  resetFakes();
  bookingResult = { id: 55 };
  await emitAttendanceSignals({ customerId: 1, bookingId: 100, gymId: 9, city: 'Gurugram', source: 'partner_verified' });
  assert.equal(notifyCalls.length, 1, 'the attendance-event notify is independent of whether the badge fired');
});

test('emitAttendanceSignals: badge check throwing is swallowed, notify still fires', async () => {
  resetFakes();
  throwOnBookingLookup = true;
  await assert.doesNotReject(() =>
    emitAttendanceSignals({ customerId: 1, bookingId: 100, gymId: 9, city: 'Gurugram', source: 'manual_override' })
  );
  assert.equal(notifyCalls.length, 1, 'a badge-check failure must never block the coin/streak signal');
});

test('emitMemberAttendanceSignals: first-ever visit -> badge check runs clean, notify fires with member_checkin source', async () => {
  resetFakes();
  await emitMemberAttendanceSignals({ customerId: 2, attendanceId: 200, gymId: 9, city: 'Gurugram' });
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].memberAttendanceId, 200);
  assert.equal(notifyCalls[0].idempotencyKey, 'member-checkin:200');
  assert.equal(notifyCalls[0].source, 'member_checkin');
});

test('emitMemberAttendanceSignals: badge check throwing is swallowed, notify still fires', async () => {
  resetFakes();
  throwOnBookingLookup = true;
  await assert.doesNotReject(() =>
    emitMemberAttendanceSignals({ customerId: 2, attendanceId: 200, gymId: 9, city: 'Gurugram' })
  );
  assert.equal(notifyCalls.length, 1);
});
