// Covers QA test plan A6/A7 (threshold-driven qualification) and D6/E4
// (idempotency on the new idempotencyKey). Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// In-memory fake of the prisma models streakService.js itself touches
// directly (AttendanceEventLog/UserStreakWeek/UserStreak). Coin economy
// config and coin crediting are mocked separately below, one level up —
// see loadStreakServiceWithMocks.
function makeFakePrisma() {
  const attendanceEvents = new Map(); // idempotencyKey -> row
  const streakWeeks = new Map(); // `${userId}|${weekStart.toISOString()}` -> row
  let nextId = 1;

  return {
    db: { attendanceEvents, streakWeeks },
    client: class {
      constructor() {
        this.attendanceEventLog = {
          findUnique: async ({ where: { idempotencyKey } }) => attendanceEvents.get(idempotencyKey) ?? null,
          create: async ({ data }) => {
            const row = { id: nextId++, ...data };
            attendanceEvents.set(data.idempotencyKey, row);
            return row;
          },
        };
        this.userStreakWeek = {
          upsert: async ({ where, update, create }) => {
            const key = `${where.userId_weekStart.userId}|${where.userId_weekStart.weekStart.toISOString()}`;
            const existing = streakWeeks.get(key);
            const row = existing
              ? { ...existing, checkinCount: existing.checkinCount + (update.checkinCount?.increment ?? 0) }
              : { id: nextId++, checkinCount: create.checkinCount, closedAt: null, ...create };
            streakWeeks.set(key, row);
            return row;
          },
          findMany: async ({ where }) => {
            return [...streakWeeks.values()].filter(
              (w) => w.weekStart.getTime() === where.weekStart.getTime() && w.closedAt === where.closedAt
            );
          },
          update: async ({ where, data }) => {
            const row = [...streakWeeks.values()].find((w) => w.id === where.id);
            Object.assign(row, data);
            return row;
          },
        };
        this.userStreak = {
          _byUser: new Map(),
          upsert: async ({ where, create }) => {
            if (!this.userStreak._byUser.has(where.userId)) this.userStreak._byUser.set(where.userId, { ...create });
            return this.userStreak._byUser.get(where.userId);
          },
          update: async ({ where, data }) => {
            const row = this.userStreak._byUser.get(where.userId);
            Object.assign(row, data);
            return row;
          },
        };
      }
    },
  };
}

async function loadStreakServiceWithMocks({ economyConfig, creditCalls }) {
  const fake = makeFakePrisma();
  const cacheBust = Math.random().toString(36).slice(2);

  const { pathToFileURL } = await import('node:url');
  const { default: path } = await import('node:path');

  // coinEconomyConfigService.js and coinLedgerService.js are mocked directly
  // (rather than only mocking @prisma/client underneath them) because
  // streakService.js's own `import './coinEconomyConfigService.js'` is NOT
  // cache-busted per test — only the top-level streakService.js import is —
  // so without this, the config module's `prisma` instance would freeze on
  // whichever test happened to import it first.
  const _t = globalThis.__currentTestContext;
  _t.mock.module('@prisma/client', { exports: { PrismaClient: fake.client } });
  _t.mock.module(pathToFileURL(path.resolve('services/coinLedgerService.js')).href, {
    exports: {
      creditCoinsService: async (userId, amount, description, idempotencyKey) => {
        creditCalls.push({ userId, amount, description, idempotencyKey });
        return { ok: true };
      },
    },
  });
  _t.mock.module(pathToFileURL(path.resolve('services/coinEconomyConfigService.js')).href, {
    exports: {
      loadEconomyConfig: async () => ({
        coinsPerCheckin: 10, weeklyTargetBonus: 20, milestones: {}, pairedStreakWeeklyBonus: 15,
        qualifyingCheckinsPerWeek: 2,
        ...economyConfig,
      }),
    },
  });

  const mod = await import(`../services/streakService.js?t=${cacheBust}`);
  return { ...mod, fake };
}

test('recordAttendanceEvent is idempotent on idempotencyKey (booking retry)', async (t) => {
  globalThis.__currentTestContext = t;
  const creditCalls = [];
  const { recordAttendanceEvent } = await loadStreakServiceWithMocks({
    economyConfig: { coinsPerCheckin: 10, weeklyTargetBonus: 20, milestones: {}, pairedStreakWeeklyBonus: 15, qualifyingCheckinsPerWeek: 2 },
    creditCalls,
  });

  const args = { userId: 1, bookingId: 501, gymId: 9, attendedAt: '2026-08-24T10:00:00Z', source: 'self_checkin', idempotencyKey: 'booking:501' };
  const first = await recordAttendanceEvent(args);
  const second = await recordAttendanceEvent(args); // simulated retry

  assert.equal(first.alreadyRecorded, false);
  assert.equal(second.alreadyRecorded, true);
  assert.equal(creditCalls.length, 1, 'coins credited exactly once despite the retry');
  assert.equal(creditCalls[0].idempotencyKey, 'checkin-coins:booking:501');
});

test('recordAttendanceEvent for a member-checkin (no bookingId) still records and pays', async (t) => {
  globalThis.__currentTestContext = t;
  const creditCalls = [];
  const { recordAttendanceEvent } = await loadStreakServiceWithMocks({
    economyConfig: { coinsPerCheckin: 10, weeklyTargetBonus: 20, milestones: {}, pairedStreakWeeklyBonus: 15, qualifyingCheckinsPerWeek: 2 },
    creditCalls,
  });

  const result = await recordAttendanceEvent({
    userId: 2, memberAttendanceId: 77, gymId: 9, attendedAt: '2026-08-24T10:00:00Z',
    source: 'member_checkin', idempotencyKey: 'member-checkin:77',
  });

  assert.equal(result.alreadyRecorded, false);
  assert.equal(creditCalls.length, 1);
  assert.equal(creditCalls[0].idempotencyKey, 'checkin-coins:member-checkin:77');
});

test('closeWeek respects a non-default qualifyingCheckinsPerWeek (below threshold does not qualify)', async (t) => {
  globalThis.__currentTestContext = t;
  const creditCalls = [];
  const { recordAttendanceEvent, closeWeek, fake } = await loadStreakServiceWithMocks({
    economyConfig: { coinsPerCheckin: 10, weeklyTargetBonus: 20, milestones: { '2': 50 }, pairedStreakWeeklyBonus: 15, qualifyingCheckinsPerWeek: 3 },
    creditCalls,
  });

  const monday = '2026-08-24T09:00:00Z'; // an ISO Monday
  await recordAttendanceEvent({ userId: 3, bookingId: 1, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:1' });
  await recordAttendanceEvent({ userId: 3, bookingId: 2, gymId: 9, attendedAt: monday, source: 'self_checkin', idempotencyKey: 'booking:2' });
  // only 2 check-ins this week, threshold is 3
  creditCalls.length = 0; // ignore per-checkin credits, only care about the weekly-bonus credit below

  const results = await closeWeek(new Date(monday));
  assert.equal(results[0].qualified, false, 'threshold is 3, user only checked in twice — must not qualify');
  assert.equal(creditCalls.length, 0, 'no weekly-target bonus paid for an unqualified week');
});

test('closeWeek qualifies once checkinCount reaches the configured threshold', async (t) => {
  globalThis.__currentTestContext = t;
  const creditCalls = [];
  const { recordAttendanceEvent, closeWeek } = await loadStreakServiceWithMocks({
    economyConfig: { coinsPerCheckin: 10, weeklyTargetBonus: 20, milestones: { '1': 50 }, pairedStreakWeeklyBonus: 15, qualifyingCheckinsPerWeek: 3 },
    creditCalls,
  });

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
