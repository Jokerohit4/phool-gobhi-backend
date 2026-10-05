// Server-side day close. The two properties that matter: the server's clock
// (never the phone's) decides which day it is, and closing is idempotent - a
// day that already has a snapshot is returned, never rewritten, including when
// the nightly sweep and a user's own close race each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serverTodayIST,
  yesterdayIST,
  resolveClientClose,
  runDayCloseSweep,
} from '../services/ledger/dayCloseService.js';
import { closeDay } from '../services/ledger/scoreService.js';
import { LEDGER_POLICY_VERSION } from '../services/ledger/ledgerConsentService.js';

// 2026-09-30 20:00 UTC = 2026-10-01 01:30 IST - the workflow's own run time.
const RUN_AT = new Date('2026-09-30T20:00:00.000Z');

test('IST day arithmetic: 01:30 IST on 1 Oct is "today = 1 Oct, yesterday = 30 Sep"', () => {
  assert.equal(serverTodayIST(RUN_AT), '2026-10-01');
  assert.equal(yesterdayIST(RUN_AT), '2026-09-30');
});

test('resolveClientClose: the server decides today, whatever the client thinks', () => {
  assert.deepEqual(resolveClientClose({ localDate: '2026-10-01', now: RUN_AT }), { today: '2026-10-01' });
  assert.deepEqual(resolveClientClose({ localDate: '2026-09-20', now: RUN_AT }), { today: '2026-10-01' },
    'a past day may be closed late, scored against the server today');
});

test('resolveClientClose: a future day (phone clock moved forward) is refused', () => {
  assert.throws(() => resolveClientClose({ localDate: '2026-10-02', now: RUN_AT }), (e) => e.code === 'FUTURE_DAY');
});

test('resolveClientClose: a malformed date is a 400, not a snapshot keyed on junk', () => {
  assert.throws(() => resolveClientClose({ localDate: '1 Oct', now: RUN_AT }), (e) => e.status === 400);
});

// A small fake with just what closeDay + the sweep read.
function fakePrisma({ consents = [], goals = [], snapshots = [], raceOnCreate = false } = {}) {
  const state = { created: [] };
  return {
    state,
    healthConsent: {
      findMany: async ({ where }) =>
        consents.filter((c) => c.revokedAt == null && (c.scopes || []).includes(where.scopes.has)),
    },
    healthGoal: {
      findMany: async ({ where }) => goals.filter((g) => where.userId.in.includes(g.userId)),
      findUnique: async ({ where }) => goals.find((g) => g.userId === where.userId) || null,
    },
    scoreDaySnapshot: {
      findUnique: async ({ where: { userId_localDate: k } }) =>
        snapshots.find((s) => s.userId === k.userId && s.localDate === k.localDate) || null,
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }) => {
        if (raceOnCreate) {
          // Another closer inserted between our findUnique and our create.
          snapshots.push({ ...data, close: 999, id: 'winner' });
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        state.created.push(data);
        snapshots.push(data);
        return data;
      },
    },
    nutritionTarget: { findFirst: async () => null },
    planItem: { findMany: async () => [] },
    planItemCompletion: { findMany: async () => [] },
    foodLog: { findMany: async () => [] },
    workoutSession: { findMany: async () => [] },
    exerciseRecord: { findMany: async () => [] },
    biometricEntry: { findMany: async () => [] },
  };
}

const on = async () => true;
const consent = (userId, version = LEDGER_POLICY_VERSION) => ({
  userId, revokedAt: null, scopes: ['logs', 'nutrition'], scopeVersions: { nutrition: version },
});

test('closeDay: a lost insert race returns the winning row, never throws, never overwrites', async () => {
  const prisma = fakePrisma({ raceOnCreate: true });
  const out = await closeDay(prisma, { userId: 1, localDate: '2026-09-30', today: '2026-10-01' });
  assert.equal(out.alreadyClosed, true);
  assert.equal(out.id, 'winner');
});

test('sweep: closes yesterday for eligible users; a second run writes nothing', async () => {
  const prisma = fakePrisma({ consents: [consent(1), consent(2)], goals: [{ userId: 1 }, { userId: 2 }] });
  const first = await runDayCloseSweep(prisma, { now: RUN_AT, isEnabled: on });
  assert.equal(first.localDate, '2026-09-30');
  assert.equal(first.closed, 2);
  assert.ok(prisma.state.created.every((r) => r.localDate === '2026-09-30'));

  const second = await runDayCloseSweep(prisma, { now: RUN_AT, isEnabled: on });
  assert.equal(second.closed, 0);
  assert.equal(second.alreadyClosed, 2);
  assert.equal(prisma.state.created.length, 2, 'the re-run must not create another row');
});

test('sweep: stale-wording consent and never-set-up users are skipped, not closed', async () => {
  const prisma = fakePrisma({
    consents: [consent(1), consent(2, '2020-01-01'), consent(3)],
    goals: [{ userId: 1 }, { userId: 2 }], // user 3 granted but never set up the ledger
  });
  const out = await runDayCloseSweep(prisma, { now: RUN_AT, isEnabled: on });
  assert.equal(out.closed, 1);
  assert.equal(out.skipped, 2);
});

test('sweep: with either ledger flag off it writes nothing', async () => {
  const prisma = fakePrisma({ consents: [consent(1)], goals: [{ userId: 1 }] });
  const out = await runDayCloseSweep(prisma, { now: RUN_AT, isEnabled: async (f) => f !== 'healthLedger' });
  assert.equal(out.disabled, true);
  assert.equal(prisma.state.created.length, 0);
});

test('sweep: a caller that forgets isEnabled gets a no-op, not an ungated write', async () => {
  const prisma = fakePrisma({ consents: [consent(1)], goals: [{ userId: 1 }] });
  const out = await runDayCloseSweep(prisma, { now: RUN_AT });
  assert.equal(out.disabled, true);
  assert.equal(prisma.state.created.length, 0);
});
