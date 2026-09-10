// Covers QA test plan A6/A7 (threshold-driven qualification) and D6/E4
// (idempotency on the new idempotencyKey), plus getStreakService. Run with:
//   node --experimental-test-module-mocks --test
//
// Single import of the SUT for the whole file (see coinEconomyConfigService
// test's header comment for why — repeated cache-busted re-imports confuse
// --experimental-test-coverage's per-file aggregation). All three of
// streakService's dependencies (@prisma/client, coinLedgerService,
// coinEconomyConfigService) are mocked once with mutable state that each
// test resets/reconfigures.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = { attendanceEvents: new Map(), streakWeeks: new Map(), userStreaks: new Map() };
let nextId = 1;
let economyConfig = { coinsPerCheckin: 10, weeklyTargetBonus: 20, milestones: {}, pairedStreakWeeklyBonus: 15, qualifyingCheckinsPerWeek: 2 };
let creditCalls = [];

function resetFakes() {
  db.attendanceEvents.clear();
  db.streakWeeks.clear();
  db.userStreaks.clear();
  nextId = 1;
  economyConfig = { coinsPerCheckin: 10, weeklyTargetBonus: 20, milestones: {}, pairedStreakWeeklyBonus: 15, qualifyingCheckinsPerWeek: 2 };
  creditCalls = [];
}

let recordAttendanceEvent, closeWeek, getStreakService;

test('setup: mock dependencies once, import the real module once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.attendanceEventLog = {
            findUnique: async ({ where: { idempotencyKey } }) => db.attendanceEvents.get(idempotencyKey) ?? null,
            create: async ({ data }) => {
              const row = { id: nextId++, ...data };
              db.attendanceEvents.set(data.idempotencyKey, row);
              return row;
            },
          };
          this.userStreakWeek = {
            upsert: async ({ where, update, create }) => {
              const key = `${where.userId_weekStart.userId}|${where.userId_weekStart.weekStart.toISOString()}`;
              const existing = db.streakWeeks.get(key);
              const row = existing
                ? { ...existing, checkinCount: existing.checkinCount + (update.checkinCount?.increment ?? 0) }
                : { id: nextId++, closedAt: null, ...create };
              db.streakWeeks.set(key, row);
              return row;
            },
            findMany: async ({ where }) =>
              [...db.streakWeeks.values()].filter(
                (w) => w.weekStart.getTime() === where.weekStart.getTime() && w.closedAt === where.closedAt
              ),
            update: async ({ where, data }) => {
              const row = [...db.streakWeeks.values()].find((w) => w.id === where.id);
              Object.assign(row, data);
              return row;
            },
          };
          this.userStreak = {
            upsert: async ({ where, create }) => {
              if (!db.userStreaks.has(where.userId)) db.userStreaks.set(where.userId, { ...create });
              return db.userStreaks.get(where.userId);
            },
            update: async ({ where, data }) => {
              const row = db.userStreaks.get(where.userId);
              Object.assign(row, data);
              return row;
            },
            findUnique: async ({ where: { userId } }) => db.userStreaks.get(userId) ?? null,
          };
        }
      },
    },
  });
  t.mock.module(new URL('../services/coinLedgerService.js', import.meta.url).href, {
    exports: {
      creditCoinsService: async (userId, amount, description, idempotencyKey) => {
        creditCalls.push({ userId, amount, description, idempotencyKey });
        return { ok: true };
      },
    },
  });
  t.mock.module(new URL('../services/coinEconomyConfigService.js', import.meta.url).href, {
    exports: { loadEconomyConfig: async () => economyConfig },
  });

  ({ recordAttendanceEvent, closeWeek, getStreakService } = await import('../services/streakService.js'));
  assert.equal(typeof recordAttendanceEvent, 'function');
});

test('recordAttendanceEvent is idempotent on idempotencyKey (booking retry)', async () => {
  resetFakes();
  const args = { userId: 1, bookingId: 501, gymId: 9, attendedAt: '2026-08-24T10:00:00Z', source: 'self_checkin', idempotencyKey: 'booking:501' };
  const first = await recordAttendanceEvent(args);
  const second = await recordAttendanceEvent(args); // simulated retry

  assert.equal(first.alreadyRecorded, false);
  assert.equal(second.alreadyRecorded, true);
  assert.equal(creditCalls.length, 1, 'coins credited exactly once despite the retry');
  assert.equal(creditCalls[0].idempotencyKey, 'checkin-coins:booking:501');
});

test('recordAttendanceEvent for a member-checkin (no bookingId) still records and pays', async () => {
  resetFakes();
  const result = await recordAttendanceEvent({
    userId: 2, memberAttendanceId: 77, gymId: 9, attendedAt: '2026-08-24T10:00:00Z',
    source: 'member_checkin', idempotencyKey: 'member-checkin:77',
  });

  assert.equal(result.alreadyRecorded, false);
  assert.equal(creditCalls.length, 1);
  assert.equal(creditCalls[0].idempotencyKey, 'checkin-coins:member-checkin:77');
  assert.equal(db.attendanceEvents.get('member-checkin:77').bookingId, null);
});

test('recordAttendanceEvent skips the coin credit entirely when coinsPerCheckin is 0', async () => {
  resetFakes();
  economyConfig.coinsPerCheckin = 0;
  await recordAttendanceEvent({ userId: 3, bookingId: 900, gymId: 9, attendedAt: '2026-08-24T10:00:00Z', source: 'self_checkin', idempotencyKey: 'booking:900' });
  assert.equal(creditCalls.length, 0);
});

test('closeWeek respects a non-default qualifyingCheckinsPerWeek (below threshold does not qualify)', async () => {
  resetFakes();
  economyConfig.qualifyingCheckinsPerWeek = 3;
  economyConfig.milestones = { '2': 50 };
  const monday = '2026-08-24T09:00:00Z'; // an ISO Monday
  await recordAttendanceEvent({ userId: 3, bookingId: 1, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:1' });
  await recordAttendanceEvent({ userId: 3, bookingId: 2, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:2' });
  creditCalls.length = 0; // ignore per-checkin credits, only care about weekly-bonus below

  const results = await closeWeek(new Date(monday));
  assert.equal(results[0].qualified, false, 'threshold is 3, user only checked in twice — must not qualify');
  assert.equal(results[0].currentStreak, 0);
  assert.equal(creditCalls.length, 0, 'no weekly-target bonus paid for an unqualified week');
});

test('closeWeek qualifies once checkinCount reaches the configured threshold, pays weekly + milestone bonus', async () => {
  resetFakes();
  economyConfig.qualifyingCheckinsPerWeek = 3;
  economyConfig.milestones = { '1': 50 };
  const monday = '2026-08-24T09:00:00Z';
  await recordAttendanceEvent({ userId: 4, bookingId: 10, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:10' });
  await recordAttendanceEvent({ userId: 4, bookingId: 11, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:11' });
  await recordAttendanceEvent({ userId: 4, bookingId: 12, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:12' });
  creditCalls.length = 0;

  const results = await closeWeek(new Date(monday));
  assert.equal(results[0].qualified, true);
  assert.equal(results[0].currentStreak, 1);

  const descriptions = creditCalls.map((c) => c.description);
  assert.ok(descriptions.includes('Weekly streak target bonus'));
  assert.ok(descriptions.includes('1-week streak milestone'));
});

test('closeWeek skips the weekly-target bonus when it is configured to 0, and skips a milestone that has no entry for the reached week', async () => {
  resetFakes();
  economyConfig.qualifyingCheckinsPerWeek = 1;
  economyConfig.weeklyTargetBonus = 0;
  economyConfig.milestones = { '5': 500 }; // week 1 (this test's streak length) has no milestone entry
  const monday = '2026-08-24T09:00:00Z';
  await recordAttendanceEvent({ userId: 5, bookingId: 20, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:20' });
  creditCalls.length = 0;

  const results = await closeWeek(new Date(monday));
  assert.equal(results[0].qualified, true);
  assert.equal(creditCalls.length, 0, 'no weekly bonus (configured 0) and no milestone (week 1 has no entry)');
});

test('closeWeek advances an existing streak on a second consecutive qualified week', async () => {
  resetFakes();
  economyConfig.qualifyingCheckinsPerWeek = 1;
  economyConfig.milestones = {};
  const week1 = '2026-08-17T09:00:00Z';
  const week2 = '2026-08-24T09:00:00Z';

  await recordAttendanceEvent({ userId: 6, bookingId: 30, gymId: 9, attendedAt: week1, source: 'self_checkin', idempotencyKey: 'booking:30' });
  const firstWeekResult = await closeWeek(new Date(week1));
  assert.equal(firstWeekResult[0].currentStreak, 1);

  await recordAttendanceEvent({ userId: 6, bookingId: 31, gymId: 9, attendedAt: week2, source: 'self_checkin', idempotencyKey: 'booking:31' });
  const secondWeekResult = await closeWeek(new Date(week2));
  assert.equal(secondWeekResult[0].currentStreak, 2, 'streak advances across consecutive qualified weeks');
});

test('closeWeek resets currentStreak to 0 on an unqualified week', async () => {
  resetFakes();
  economyConfig.qualifyingCheckinsPerWeek = 1;
  economyConfig.milestones = {};
  const week1 = '2026-08-17T09:00:00Z';
  const week2 = '2026-08-24T09:00:00Z';

  await recordAttendanceEvent({ userId: 7, bookingId: 40, gymId: 9, attendedAt: week1, source: 'self_checkin', idempotencyKey: 'booking:40' });
  await closeWeek(new Date(week1)); // qualifies, streak -> 1

  // Force week2 to be a distinct UserStreakWeek row with 0 check-ins by
  // upserting it directly through recordAttendanceEvent for a DIFFERENT
  // user and then closing week2 for user 7 requires a week2 row to exist —
  // simulate by recording and immediately not qualifying (threshold 1 means
  // any recorded event qualifies, so instead bump the threshold for week2).
  economyConfig.qualifyingCheckinsPerWeek = 2;
  await recordAttendanceEvent({ userId: 7, bookingId: 41, gymId: 9, attendedAt: week2, source: 'self_checkin', idempotencyKey: 'booking:41' });
  const secondWeekResult = await closeWeek(new Date(week2));

  assert.equal(secondWeekResult[0].qualified, false);
  assert.equal(secondWeekResult[0].currentStreak, 0, 'an unqualified week resets the streak');
});

test('getStreakService returns the stored streak for a known user', async () => {
  resetFakes();
  economyConfig.qualifyingCheckinsPerWeek = 1;
  const monday = '2026-08-24T09:00:00Z';
  await recordAttendanceEvent({ userId: 8, bookingId: 50, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:50' });
  await closeWeek(new Date(monday));

  const streak = await getStreakService(8);
  assert.equal(streak.currentStreak, 1);
});

test('getStreakService returns a zeroed default for a user with no streak row yet', async () => {
  resetFakes();
  const streak = await getStreakService(999);
  assert.deepEqual(streak, { userId: 999, currentStreak: 0, longestStreak: 0, lastQualifiedWeekStart: null });
});
