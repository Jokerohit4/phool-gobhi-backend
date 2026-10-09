// The two P1s the 2026-10-08 launch audit pinned on this file:
//
//   1. "Check-ins before 05:30 IST count as the previous day, so
//      early-morning gym-goers get no coins" — the attendance window was
//      built with setUTCHours.
//   2. "Coins are credited for each session, with no daily limit, once any
//      check-in exists that day" — the ledger key was the caller's sessionId,
//      so one check-in paid for unlimited finishes.
//
// Both are pinned here with times chosen so the OLD code fails: an
// attendance at 00:00 IST (18:30 UTC the previous day) has to be inside
// today's window, and a second finish on the same IST day has to be a
// replay. Run with:
//   node --experimental-test-module-mocks --test
//
// Single import of the SUT for the whole file (see coinEconomyConfigService
// test's header comment for why - repeated cache-busted re-imports confuse
// --experimental-test-coverage's per-file aggregation). All four
// dependencies (@prisma/client, coinLedgerService, coinEconomyConfigService,
// analytics) are mocked once with mutable state each test resets.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let attendance = []; // [{ userId, attendedAt: Date }]
const ledger = new Map(); // idempotencyKey -> { idempotencyKey, userId }
let creditCalls = [];
let trackCalls = [];
let economyConfig = { coinsPerVerifiedWorkout: 15 };

function setAttendance(userId, iso) {
  attendance.push({ userId, attendedAt: new Date(iso) });
}

function resetFakes() {
  attendance = [];
  ledger.clear();
  creditCalls = [];
  trackCalls = [];
  economyConfig = { coinsPerVerifiedWorkout: 15 };
}

let verifyAndCreditWorkout;

test('setup: mock dependencies once, import workoutCreditService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.attendanceEventLog = {
            // One attendance row per user in these tests; the range filter is
            // the whole point of the query, so honour it exactly.
            findFirst: async ({ where }) => {
              const hit = attendance.find(
                (a) =>
                  a.userId === where.userId &&
                  a.attendedAt >= where.attendedAt.gte &&
                  a.attendedAt <= where.attendedAt.lte,
              );
              return hit ? { id: 1 } : null;
            },
          };
          this.coinLedgerEntry = {
            findUnique: async ({ where }) => ledger.get(where.idempotencyKey) ?? null,
          };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../services/coinLedgerService.js', import.meta.url).href, {
    exports: {
      creditCoinsService: async (userId, amount, description, idempotencyKey) => {
        creditCalls.push({ userId, amount, description, idempotencyKey });
        // Mirrors the real service: a replay of an already-applied key
        // records nothing new.
        if (idempotencyKey && !ledger.has(idempotencyKey)) {
          ledger.set(idempotencyKey, { idempotencyKey, userId });
        }
        return { userId, balance: amount, updatedAt: new Date() };
      },
    },
  });
  t.mock.module(new URL('../services/coinEconomyConfigService.js', import.meta.url).href, {
    exports: { loadEconomyConfig: async () => economyConfig },
  });
  t.mock.module(new URL('../utils/analytics.js', import.meta.url).href, {
    exports: { track: (event, userId, props) => trackCalls.push({ event, userId, props }) },
  });

  ({ verifyAndCreditWorkout } = await import('../services/workoutCreditService.js'));
  assert.equal(typeof verifyAndCreditWorkout, 'function');
});

// ---- IST day ---------------------------------------------------------------

test('an attendance at 00:00 IST counts as today: the window is IST, not UTC', async () => {
  resetFakes();
  // 18:30 UTC 7 Oct == 00:00 IST 8 Oct; "now" is 07:30 IST 8 Oct.
  setAttendance(7, '2026-10-07T18:30:00.000Z');
  const result = await verifyAndCreditWorkout({
    userId: 7, sessionId: 501, description: 'Verified workout — Squat', idempotencyKey: 'workout-credit:501',
    now: new Date('2026-10-08T02:00:00.000Z'),
  });
  assert.deepEqual(result, { verified: true, credited: true, amount: 15 });
  assert.equal(creditCalls.length, 1);
  assert.equal(creditCalls[0].idempotencyKey, 'workout-credit:7:2026-10-08', 'the ledger key is the IST day');
});

test('the window closes at the end of the IST day, not the end of the UTC day', async () => {
  resetFakes();
  // 18:00 UTC 7 Oct == 23:00 IST 7 Oct — still "today" at 23:30 IST, but the
  // same attendance is already "yesterday" once the clock passes 00:30 IST.
  setAttendance(7, '2026-10-07T18:00:00.000Z');
  const lateNight = await verifyAndCreditWorkout({
    userId: 7, sessionId: 502, idempotencyKey: 'workout-credit:502',
    now: new Date('2026-10-07T18:00:00.000Z'),
  });
  assert.deepEqual(lateNight, { verified: true, credited: true, amount: 15 });
  assert.equal(creditCalls[0].idempotencyKey, 'workout-credit:7:2026-10-07');

  const pastMidnight = await verifyAndCreditWorkout({
    userId: 7, sessionId: 503, idempotencyKey: 'workout-credit:503',
    now: new Date('2026-10-07T19:00:00.000Z'), // 00:30 IST 8 Oct
  });
  assert.deepEqual(pastMidnight, { verified: false, credited: false, amount: 0 });
  assert.equal(creditCalls.length, 1, 'the miss must not credit anything');
});

test('an attendance from yesterday does not verify a workout today', async () => {
  resetFakes();
  setAttendance(7, '2026-10-06T10:00:00.000Z');
  const result = await verifyAndCreditWorkout({
    userId: 7, sessionId: 504, idempotencyKey: 'workout-credit:504',
    now: new Date('2026-10-08T02:00:00.000Z'),
  });
  assert.deepEqual(result, { verified: false, credited: false, amount: 0 });
  assert.equal(creditCalls.length, 0);
});

// ---- daily cap -------------------------------------------------------------

test('a second finish on the same IST day is verified but not paid (no coin farm)', async () => {
  resetFakes();
  setAttendance(3, '2026-10-08T06:00:00.000Z');
  const now = new Date('2026-10-08T10:00:00.000Z');

  const first = await verifyAndCreditWorkout({ userId: 3, sessionId: 1, idempotencyKey: 'workout-credit:1', now });
  const second = await verifyAndCreditWorkout({ userId: 3, sessionId: 2, idempotencyKey: 'workout-credit:2', now });

  assert.deepEqual(first, { verified: true, credited: true, amount: 15 });
  assert.deepEqual(second, { verified: true, credited: false, amount: 0 },
    'the second workout of the day must not promise coins the ledger will not pay');
  assert.equal(creditCalls.length, 1, 'exactly one payment for the day');
  assert.equal(creditCalls[0].idempotencyKey, 'workout-credit:3:2026-10-08');
});

test('the cap is per user per day: another user still gets paid', async () => {
  resetFakes();
  setAttendance(3, '2026-10-08T06:00:00.000Z');
  setAttendance(4, '2026-10-08T06:00:00.000Z');
  const now = new Date('2026-10-08T10:00:00.000Z');

  const first = await verifyAndCreditWorkout({ userId: 3, sessionId: 1, idempotencyKey: 'workout-credit:1', now });
  const other = await verifyAndCreditWorkout({ userId: 4, sessionId: 2, idempotencyKey: 'workout-credit:2', now });

  assert.equal(first.credited, true);
  assert.deepEqual(other, { verified: true, credited: true, amount: 15 });
  assert.equal(creditCalls.length, 2);
  assert.equal(creditCalls[1].idempotencyKey, 'workout-credit:4:2026-10-08',
    'the key must carry the userId — CoinLedgerEntry.idempotencyKey is globally unique');
});

test('the cap resets at the next IST midnight', async () => {
  resetFakes();
  setAttendance(3, '2026-10-08T06:00:00.000Z');
  setAttendance(3, '2026-10-09T06:00:00.000Z');

  const day1 = await verifyAndCreditWorkout({
    userId: 3, sessionId: 1, idempotencyKey: 'workout-credit:1',
    now: new Date('2026-10-08T10:00:00.000Z'),
  });
  const day2 = await verifyAndCreditWorkout({
    userId: 3, sessionId: 3, idempotencyKey: 'workout-credit:3',
    now: new Date('2026-10-09T10:00:00.000Z'),
  });

  assert.deepEqual(day1, { verified: true, credited: true, amount: 15 });
  assert.deepEqual(day2, { verified: true, credited: true, amount: 15 },
    'the key is day-scoped, so a new IST day is not a replay of the last one');
  assert.equal(creditCalls.length, 2);
  assert.equal(creditCalls[0].idempotencyKey, 'workout-credit:3:2026-10-08');
  assert.equal(creditCalls[1].idempotencyKey, 'workout-credit:3:2026-10-09');
});

// ---- existing behaviour that must not regress -------------------------------

test('economy disabled -> verified, not credited, nothing written', async () => {
  resetFakes();
  economyConfig = { coinsPerVerifiedWorkout: 0 };
  setAttendance(5, '2026-10-08T06:00:00.000Z');
  const result = await verifyAndCreditWorkout({
    userId: 5, sessionId: 9, idempotencyKey: 'workout-credit:9',
    now: new Date('2026-10-08T10:00:00.000Z'),
  });
  assert.deepEqual(result, { verified: true, credited: false, amount: 0 });
  assert.equal(creditCalls.length, 0);
  assert.ok(trackCalls.some((c) => c.props.economy_disabled === true));
});

test('every outcome emits exactly one workout_credited event', async () => {
  resetFakes();
  setAttendance(6, '2026-10-08T06:00:00.000Z');
  const now = new Date('2026-10-08T10:00:00.000Z');

  await verifyAndCreditWorkout({ userId: 6, sessionId: 1, idempotencyKey: 'workout-credit:1', now });
  await verifyAndCreditWorkout({ userId: 6, sessionId: 2, idempotencyKey: 'workout-credit:2', now });
  await verifyAndCreditWorkout({ userId: 8, sessionId: 3, idempotencyKey: 'workout-credit:3', now });

  const events = trackCalls.filter((c) => c.event === 'workout_credited');
  assert.equal(events.length, 3, 'no track() call was added or dropped by the cap/IST work');
  assert.equal(events.filter((c) => c.userId === 6).length, 2);
  assert.equal(events.filter((c) => c.userId === 6 && c.props.credited === true).length, 1,
    'the second finish is tracked as already-credited, not as a second payment');
  assert.deepEqual(events.find((c) => c.userId === 8).props,
    { verified: false, credited: false, amount: 0 }, 'no attendance -> not verified');
});
