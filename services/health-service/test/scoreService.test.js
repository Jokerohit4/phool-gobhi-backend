import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDay,
  getCalmSeries,
  getSafetyFlag,
  getScoreSeries,
  previewDay,
  setCalmMode,
} from '../services/ledger/scoreService.js';

const TODAY = '2026-09-28';
const USER = 7;

function mockPrisma({ snapshots = [], goal = null, target = null, planItems = [], logs = [] } = {}) {
  const state = { created: [], updated: [] };
  const prisma = {
    state,
    scoreDaySnapshot: {
      create: async (a) => {
        state.created.push(a.data);
        return a.data;
      },
      findMany: async (a) => {
        let rows = [...snapshots];
        if (a.where?.localDate?.lt) {
          rows = rows.filter((r) => r.localDate < a.where.localDate.lt);
        }
        rows.sort((x, y) =>
          a.orderBy?.localDate === 'desc'
            ? y.localDate.localeCompare(x.localDate)
            : x.localDate.localeCompare(y.localDate),
        );
        return a.take ? rows.slice(0, a.take) : rows;
      },
      findFirst: async (a) => {
        const rows = snapshots
          .filter((r) => r.userId === USER && r.localDate < a.where.localDate.lt)
          .sort((x, y) => y.localDate.localeCompare(x.localDate));
        return rows[0] || null;
      },
      findUnique: async (a) => {
        const key = a.where.userId_localDate;
        if (!key) return null;
        return snapshots.find((r) => r.userId === key.userId && r.localDate === key.localDate) || null;
      },
    },
    nutritionTarget: { findUnique: async () => target },
    healthGoal: {
      findUnique: async () => goal,
      update: async (a) => ((state.updated.push(a.data), { userId: USER, ...a.data })),
    },
    planItem: { findMany: async () => planItems },
    foodLog: { findMany: async () => logs },
  };
  return prisma;
}

const TARGET = { kcal: 2000, proteinG: 120, carbsG: 220, fatG: 65, fibreG: 28, waterMl: 2800, micros: {} };

// --- freezing --------------------------------------------------------------

test('a closed day writes one snapshot row and never rewrites it', async () => {
  const prisma = mockPrisma({ target: TARGET });
  const snap = await closeDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(prisma.state.created.length, 1);
  assert.equal(snap.localDate, TODAY);
  // Always recorded, so a historical day stays explicable after a retune.
  assert.ok(snap.rulesVersion);
});

test('re-closing a day returns the frozen row rather than recomputing it', async () => {
  const frozen = { userId: USER, localDate: '2026-09-20', open: 10, high: 20, low: 5, close: 18, breakdown: [], rulesVersion: 'v1' };
  const prisma = mockPrisma({ snapshots: [frozen], target: TARGET });
  const out = await closeDay(prisma, { userId: USER, localDate: '2026-09-20', today: TODAY });
  // The second call is usually a client retry. Replacing a frozen day is
  // exactly the failure this design exists to prevent.
  assert.equal(out.close, 18);
  assert.equal(out.alreadyClosed, true);
  assert.equal(prisma.state.created.length, 0);
});

test("the first day ever starts at zero, not an invented baseline", async () => {
  const prisma = mockPrisma({ target: TARGET });
  const snap = await closeDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(snap.open, 0);
});

test('a day opens at the previous day\'s close, so the chain is continuous', async () => {
  const prisma = mockPrisma({
    snapshots: [{ userId: USER, localDate: '2026-09-27', open: 0, high: 5, low: -3, close: 2, breakdown: [], rulesVersion: 'v1' }],
    target: TARGET,
  });
  const snap = await closeDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(snap.open, 2);
});

test('a gap in the chain does not invent the missing days', async () => {
  // The chain runs off stored snapshots, not off elapsed calendar days, so a
  // week away does not silently rebase the score.
  const prisma = mockPrisma({
    snapshots: [{ userId: USER, localDate: '2026-09-01', open: 0, high: 0, low: 0, close: 40, breakdown: [], rulesVersion: 'v1' }],
    target: TARGET,
  });
  const snap = await closeDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(snap.open, 40);
});

// --- preview ---------------------------------------------------------------

test("previewing today writes nothing", async () => {
  const prisma = mockPrisma({ target: TARGET });
  const out = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  // Today's score is still moving, so there is nothing to freeze.
  assert.equal(prisma.state.created.length, 0);
  assert.equal(out.localDate, TODAY);
});

test('an open day records earns but no misses', async () => {
  const prisma = mockPrisma({
    target: TARGET,
    planItems: [
      { id: 1, kind: 'workout', schedule: 'daily', active: true, endsOn: null, completions: [] },
    ],
  });
  const out = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  // Mid-day, an unticked workout is not a failure yet.
  assert.equal(out.breakdown.some((l) => l.points < 0), false);
});

// --- reading the series ----------------------------------------------------

test('the series is oldest first, for a chart', async () => {
  const prisma = mockPrisma({
    snapshots: [
      { userId: USER, localDate: '2026-09-26', open: 0, high: 1, low: 0, close: 1, breakdown: [], rulesVersion: 'v1' },
      { userId: USER, localDate: '2026-09-27', open: 1, high: 2, low: 1, close: 2, breakdown: [], rulesVersion: 'v1' },
      { userId: USER, localDate: '2026-09-28', open: 2, high: 3, low: 2, close: 3, breakdown: [], rulesVersion: 'v1' },
    ],
  });
  const series = await getScoreSeries(prisma, { userId: USER });
  assert.deepEqual(series.map((s) => s.localDate), ['2026-09-26', '2026-09-27', '2026-09-28']);
});

test('calm mode off returns the real series untouched', async () => {
  const prisma = mockPrisma({
    goal: { calmMode: false },
    snapshots: [
      { userId: USER, localDate: '2026-09-26', open: 0, high: 10, low: -8, close: 5, breakdown: [], rulesVersion: 'v1' },
      { userId: USER, localDate: '2026-09-27', open: 5, high: 20, low: 2, close: 18, breakdown: [], rulesVersion: 'v1' },
    ],
  });
  const out = await getCalmSeries(prisma, { userId: USER });
  assert.equal(out.calmMode, false);
  assert.equal(out.series[1].close, 18);
  assert.equal(out.series[1].high, 20);
});

test('calm mode flattens the chart to one line with no red', async () => {
  const prisma = mockPrisma({
    goal: { calmMode: true },
    snapshots: [
      { userId: USER, localDate: '2026-09-26', open: 0, high: 10, low: -8, close: 5, breakdown: [], rulesVersion: 'v1' },
      { userId: USER, localDate: '2026-09-27', open: 5, high: 20, low: 2, close: 18, breakdown: [], rulesVersion: 'v1' },
      { userId: USER, localDate: '2026-09-28', open: 18, high: 25, low: 10, close: 3, breakdown: [], rulesVersion: 'v1' },
    ],
  });
  const out = await getCalmSeries(prisma, { userId: USER });
  assert.equal(out.calmMode, true);
  // Flat at the starting close. Not the average - an average would still leak
  // the shape of the chain through.
  for (const row of out.series) {
    assert.equal(row.close, 0);
    assert.equal(row.high, 0);
    assert.equal(row.low, 0);
  }
  // The dates survive, so the chart still has an x-axis.
  assert.equal(out.series.length, 3);
});

test('calm mode does not delete or rewrite stored snapshots', async () => {
  const prisma = mockPrisma({ goal: { calmMode: true }, snapshots: [] });
  await getCalmSeries(prisma, { userId: USER });
  // The flattening happens on read. Toggling a display preference must never
  // touch history.
  assert.equal(prisma.state.updated.length, 0);
  assert.equal(prisma.state.created.length, 0);
});

test('calm mode still carries the rules version, so days stay explicable', async () => {
  const prisma = mockPrisma({
    goal: { calmMode: true },
    snapshots: [{ userId: USER, localDate: '2026-09-26', open: 0, high: 1, low: 0, close: 1, breakdown: [], rulesVersion: 'v1' }],
  });
  const out = await getCalmSeries(prisma, { userId: USER });
  assert.equal(out.series[0].rulesVersion, 'v1');
});

test('turning calm mode on and off is reversible and touches no snapshot', async () => {
  const prisma = mockPrisma({ goal: { calmMode: false } });
  await setCalmMode(prisma, { userId: USER, calmMode: true });
  assert.deepEqual(prisma.state.updated[0], { calmMode: true });
  await setCalmMode(prisma, { userId: USER, calmMode: false });
  assert.deepEqual(prisma.state.updated[1], { calmMode: false });
  assert.equal(prisma.state.created.length, 0);
});

// --- the safety flag -------------------------------------------------------

test('the low-intake flag is computed from recent snapshots at read time', async () => {
  // Not frozen onto a day: it is a check about the user's current state, so a
  // run that starts today has to be visible today.
  const prisma = mockPrisma({ goal: { calmMode: false }, snapshots: [] });
  const out = await getSafetyFlag(prisma, { userId: USER });
  assert.equal(out.active, false);
  assert.equal(out.calmMode, false);
});

test('the safety flag is evaluated even with no nutrition target', async () => {
  // Someone who has just onboarded has no target yet and can still be eating
  // far too little. That is exactly when the check matters most, so it must
  // not be gated on a target existing.
  const prisma = mockPrisma({ goal: { calmMode: false }, target: null, snapshots: [] });
  const out = await getSafetyFlag(prisma, { userId: USER });
  assert.equal(out.active, false);
  assert.equal(out.calmMode, false);
});
