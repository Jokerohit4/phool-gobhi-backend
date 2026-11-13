// B5 — the attendance ingest used to reject any event carrying neither a
// bookingId nor a memberAttendanceId. Independent (non-partner) check-ins have
// neither: the customer tapped "I'm here" at an UNCLAIMED gym, so there is no
// booking and no attendance-SaaS member row to point at. booking-service sends
// them with source 'independent_gym_geofence', gymId = the unclaimed gym id and
// a caller-derived `independent-<id>` idempotencyKey (its own
// recordAttendanceEvent call sits right after IndependentCheckIn.create).
//
// This pins the ingest's contract: accept that source with both ids null, and
// keep rejecting every other source that has no id. It also pins that both ids
// still flow through untouched for the booking- and member-backed paths, and
// that the streaksCoins gate on recording is unchanged (B5 step 2: coin/streak
// rules do not change — those live in streakService.test.js).
//
// Single import of the SUT for the whole file (see streakService.test.js for
// why): every module the controller imports is mocked once, with mutable state
// each test resets. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let streaksCoinsEnabled = true;
let challengesEnabled = false;
let recordCalls = [];
let offPeakCalls = [];

function resetFakes() {
  streaksCoinsEnabled = true;
  challengesEnabled = false;
  recordCalls = [];
  offPeakCalls = [];
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

let recordAttendanceEventInternal;

test('setup: mock every controller dependency once, then import the controller once', async (t) => {
  // Modules the handler under test never touches — mocked empty so importing
  // the controller cannot drag in Prisma clients or cross-service calls.
  const empty = { exports: {} };
  for (const path of [
    '../services/coinLedgerService.js',
    '../services/onboardingRewardService.js',
    '../services/erasureService.js',
    '../services/exportService.js',
    '../services/coinCatalogService.js',
    '../services/coinEconomyConfigService.js',
    '../services/challengeCatalogService.js',
    '../services/adminChallengeService.js',
    '../services/pairedStreakService.js',
    '../services/workoutCreditService.js',
    '../services/sproutSpawnService.js',
  ]) {
    t.mock.module(new URL(path, import.meta.url).href, empty);
  }
  t.mock.module(new URL('../services/streakService.js', import.meta.url).href, {
    exports: {
      recordAttendanceEvent: async (args) => {
        recordCalls.push(args);
        return { alreadyRecorded: false };
      },
    },
  });
  t.mock.module(new URL('../services/challengeEnrollmentService.js', import.meta.url).href, {
    exports: {
      advanceOffPeakChallengesService: async (userId, attendedAt) => {
        offPeakCalls.push({ userId, attendedAt });
      },
    },
  });
  t.mock.module(new URL('../middleware/requireFeatureFlag.js', import.meta.url).href, {
    exports: {
      isFeatureEnabled: async (name) =>
        name === 'streaksCoins'
          ? streaksCoinsEnabled
          : name === 'challenges'
            ? challengesEnabled
            : false,
      requireFeatureFlag: () => (req, res, next) => next(),
    },
  });

  ({ recordAttendanceEventInternal } = await import('../controllers/challengeController.js'));
  assert.equal(typeof recordAttendanceEventInternal, 'function');
});

// The exact shape booking-service emits for an independent check-in.
const independentBody = {
  userId: 42,
  bookingId: null,
  memberAttendanceId: null,
  gymId: 7,
  attendedAt: '2026-10-08T06:00:00Z',
  source: 'independent_gym_geofence',
  idempotencyKey: 'independent-901',
};

test('accepts an independent check-in with both ids null', async () => {
  resetFakes();
  const res = fakeRes();
  await recordAttendanceEventInternal({ body: independentBody }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.alreadyRecorded, false);
  assert.equal(recordCalls.length, 1, 'the independent event must reach the streak ingest');
  assert.deepEqual(recordCalls[0], independentBody);
});

test('still rejects a no-id event from any other source', async () => {
  resetFakes();
  const res = fakeRes();
  await recordAttendanceEventInternal(
    { body: { ...independentBody, source: 'booking' } },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(recordCalls.length, 0, 'a rejected event must never reach the streak ingest');
});

test('booking-backed check-ins still pass bookingId through', async () => {
  resetFakes();
  const res = fakeRes();
  await recordAttendanceEventInternal(
    {
      body: { ...independentBody, bookingId: 501, source: 'self_checkin', idempotencyKey: 'booking:501' },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].bookingId, 501);
  assert.equal(recordCalls[0].memberAttendanceId, null);
});

test('member check-ins still pass memberAttendanceId through', async () => {
  resetFakes();
  const res = fakeRes();
  await recordAttendanceEventInternal(
    {
      body: { ...independentBody, memberAttendanceId: 71, source: 'member_checkin', idempotencyKey: 'member-checkin:71' },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].memberAttendanceId, 71);
  assert.equal(recordCalls[0].bookingId, null);
});

test('missing required fields are still rejected before the id check', async () => {
  resetFakes();
  const res = fakeRes();
  const { userId, ...noUser } = independentBody;
  await recordAttendanceEventInternal({ body: noUser }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(recordCalls.length, 0);
});

test('streaksCoins off -> accepted but not recorded (flag gate unchanged)', async () => {
  resetFakes();
  streaksCoinsEnabled = false;
  const res = fakeRes();
  await recordAttendanceEventInternal({ body: independentBody }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(recordCalls.length, 0, 'recording stays gated on streaksCoins');
  assert.deepEqual(res.body.data, { alreadyRecorded: true });
});
