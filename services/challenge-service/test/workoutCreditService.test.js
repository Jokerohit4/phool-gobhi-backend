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
const presence = new Map(); // userId -> { userId, gymId, state, since, day, method }
let held = []; // HeldWorkoutCredit rows

function setAttendance(userId, iso) {
  attendance.push({ userId, attendedAt: new Date(iso) });
}

function resetFakes() {
  attendance = [];
  ledger.clear();
  creditCalls = [];
  trackCalls = [];
  economyConfig = { coinsPerVerifiedWorkout: 15 };
  presence.clear();
  held = [];
}

let verifyAndCreditWorkout, applyPresence;

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
                  a.userId === where.userId && (where.gymId == null || a.gymId === where.gymId) &&
                  a.attendedAt >= where.attendedAt.gte &&
                  a.attendedAt <= where.attendedAt.lte,
              );
              return hit ? { id: 1 } : null;
            },
          };
          this.coinLedgerEntry = {
            findUnique: async ({ where }) => ledger.get(where.idempotencyKey) ?? null,
          };
          this.gymPresence = {
            findUnique: async ({ where }) => presence.get(where.userId) ?? null,
            upsert: async ({ where, create, update }) => {
              const row = presence.get(where.userId);
              const next = row ? { ...row, ...update } : { ...create };
              presence.set(where.userId, next);
              return next;
            },
          };
          this.heldWorkoutCredit = {
            upsert: async ({ where, create }) => {
              const k = where.userId_idempotencyKey;
              const hit = held.find((h) => h.userId === k.userId && h.idempotencyKey === k.idempotencyKey);
              if (hit) return hit;
              const row = { id: held.length + 1, releasedAt: null, createdAt: new Date(held.length), ...create };
              held.push(row);
              return row;
            },
            findMany: async ({ where }) =>
              held.filter((h) => h.userId === where.userId && h.day === where.day && h.releasedAt === null),
            update: async ({ where, data }) => Object.assign(held.find((h) => h.id === where.id), data),
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
  ({ applyPresence } = await import('../services/gymPresenceService.js'));
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

test('starter workout reward is small, daily-capped and can be upgraded once at the matching location', async () => {
  resetFakes();
  const now = new Date('2026-10-26T06:00:00Z');
  const routinePolicy = { starterAmount: 2, verifiedAmount: 4,
    startedAt: '2026-10-26T05:00:00Z', endedAt: '2026-10-26T05:30:00Z', gymId: 9 };
  const args = { userId: 7, sessionId: 1, idempotencyKey: 'session:1', routinePolicy, now };
  assert.equal((await verifyAndCreditWorkout(args)).amount, 2);
  assert.equal((await verifyAndCreditWorkout({ ...args, sessionId: 2 })).amount, 0);
  attendance.push({ userId: 7, gymId: 10, attendedAt: new Date('2026-10-26T05:00:00Z') });
  assert.equal((await verifyAndCreditWorkout(args)).amount, 0, 'another gym is not location verification');
  attendance.push({ userId: 7, gymId: 9, attendedAt: new Date('2026-10-26T05:00:00Z') });
  assert.equal((await verifyAndCreditWorkout(args)).amount, 2, 'only the difference is added');
  assert.equal((await verifyAndCreditWorkout(args)).amount, 0);
  assert.equal(creditCalls.reduce((n, c) => n + c.amount, 0), 4);
});
test('steady routine rewards require attendance during the session window at the same gym', async () => {
  resetFakes();
  const routinePolicy = { starterAmount: 0, verifiedAmount: 3,
    startedAt: '2026-10-26T10:00:00Z', endedAt: '2026-10-26T11:00:00Z', gymId: 9 };
  const args = { userId: 7, sessionId: 1, idempotencyKey: 'session:1', routinePolicy, now: new Date('2026-10-26T11:01:00Z') };
  attendance.push({ userId: 7, gymId: 9, attendedAt: new Date('2026-10-26T04:00:00Z') });
  assert.equal((await verifyAndCreditWorkout(args)).amount, 0);
  attendance.push({ userId: 7, gymId: 9, attendedAt: new Date('2026-10-26T10:00:00Z') });
  assert.equal((await verifyAndCreditWorkout(args)).amount, 3);
});
test('internal routine payout is bounded to four coins', async () => {
  resetFakes();
  await assert.rejects(() => verifyAndCreditWorkout({ userId: 7, sessionId: 1,
    routinePolicy: { starterAmount: 100, verifiedAmount: 100 } }), error => error.status === 400);
});

// ---- Check-out rule ---------------------------------------------------------
// A workout finished while still checked in at a gym is held; a check-out by scan
// pays it. Leaving without scanning is allowed and simply never pays.

const NOON = new Date('2026-11-12T06:30:00.000Z'); // 12:00 IST on the 12th
const arrive = (userId = 7, gymId = 9) =>
  applyPresence({ userId, gymId, state: 'in', method: 'checkin', at: '2026-11-12T04:30:00.000Z', date: '2026-11-12' });
const finish = (extra = {}) => verifyAndCreditWorkout({
  userId: 7, sessionId: 1, description: 'Verified workout', idempotencyKey: 'workout-credit:1', now: NOON, ...extra,
});
const leave = (method, gymId = 9) =>
  applyPresence({ userId: 7, gymId, state: 'out', method, at: NOON.toISOString(), date: '2026-11-12' });

test('a workout finished while checked in is held, not paid', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z');
  await arrive();
  const r = await finish();
  assert.equal(r.credited, false);
  assert.equal(r.amount, 0);
  assert.equal(r.pendingCheckout, true);
  assert.equal(r.verified, true);
  assert.equal(creditCalls.length, 0);
  assert.equal(held.length, 1);
});

test('finishing the same workout twice holds it once', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z');
  await arrive();
  await finish();
  await finish();
  assert.equal(held.length, 1);
});

test('checking out by scan pays the held workout once, and reports the coins', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z');
  await arrive();
  await finish();
  const out = await leave('scan');
  assert.equal(out.released, 15);
  assert.equal(creditCalls.length, 1);
  assert.equal(creditCalls[0].idempotencyKey, 'workout-credit:7:2026-11-12');
  assert.notEqual(held[0].releasedAt, null);
  // A second scan-out pays nothing more.
  assert.equal((await leave('scan')).released, 0);
  assert.equal(creditCalls.length, 1);
});

test('leaving without a scan pays nothing: a tap or the server closing the visit does not release coins', async () => {
  for (const method of ['tap', 'auto']) {
    resetFakes();
    setAttendance(7, '2026-11-12T04:30:00.000Z');
    await arrive();
    await finish();
    assert.equal((await leave(method)).released, 0, method);
    assert.equal(creditCalls.length, 0, method);
    assert.equal(held[0].releasedAt, null, method);
  }
});

test('after a scanned check-out a later workout is paid normally', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z');
  await arrive();
  await leave('scan');
  assert.deepEqual(await finish(), { verified: true, credited: true, amount: 15 });
});

test('a workout with no gym visit (home) is paid exactly as before', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z'); // attendance exists, but nobody is marked inside
  const r = await finish();
  assert.equal(r.amount, 15);
  assert.equal(held.length, 0);
});

test('an arrival nobody closed yesterday does not hold today', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z');
  await applyPresence({ userId: 7, gymId: 9, state: 'in', method: 'checkin', at: '2026-11-11T11:00:00.000Z', date: '2026-11-11' });
  assert.equal((await finish()).amount, 15);
});

test('an exit reported for a different gym is ignored', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z');
  await arrive(7, 9);
  await leave('scan', 3);
  assert.equal(presence.get(7).state, 'in');
  assert.equal((await finish()).pendingCheckout, true);
});

test('WORKOUT_COINS_REQUIRE_CHECKOUT=false switches the rule off', async () => {
  resetFakes();
  setAttendance(7, '2026-11-12T04:30:00.000Z');
  await arrive();
  process.env.WORKOUT_COINS_REQUIRE_CHECKOUT = 'false';
  try {
    assert.equal((await finish()).amount, 15);
  } finally {
    delete process.env.WORKOUT_COINS_REQUIRE_CHECKOUT;
  }
});

test('a routine workout held at check-in pays its starter and location coins on scan-out', async () => {
  resetFakes();
  attendance.push({ userId: 7, gymId: 9, attendedAt: new Date('2026-11-12T05:00:00Z') });
  await arrive(7, 9);
  const routinePolicy = { starterAmount: 2, verifiedAmount: 4, startedAt: '2026-11-12T05:00:00Z', endedAt: '2026-11-12T05:40:00Z', gymId: 9 };
  const r = await verifyAndCreditWorkout({ userId: 7, sessionId: 3, idempotencyKey: 'session:3', routinePolicy, now: NOON });
  assert.equal(r.pendingCheckout, true);
  assert.equal(creditCalls.length, 0);
  assert.equal((await leave('scan')).released, 4);
});
