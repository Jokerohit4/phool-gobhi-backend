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

function mockPrisma({ snapshots = [], goal = null, target = null, planItems = [], logs = [], sessions = [] } = {}) {
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
    // where/select are honoured rather than ignored: gatherDayInputs relies on
    // the `localDate` + `endedAt: { not: null }` filter to keep a user's whole
    // session history from being loaded, and a fake that ignored the filter
    // would let a regression in the query itself pass.
    workoutSession: {
      findMany: async ({ where, select }) => {
        let rows = sessions.filter((s) => s.userId === (where?.userId ?? USER));
        if (where?.localDate) rows = rows.filter((s) => s.localDate === where.localDate);
        if (where?.endedAt?.not === null) rows = rows.filter((s) => s.endedAt != null);
        return select ? rows.map((s) => ({ id: s.id, type: s.type, endedAt: s.endedAt })) : rows;
      },
    },
  };
  return prisma;
}

const TARGET = { kcal: 2000, proteinG: 120, carbsG: 220, fatG: 65, fibreG: 28, waterMl: 2800, micros: {} };

// `schedule: 'daily'` is load-bearing: gatherDayInputs filters items through
// isDueOn, and an item with no schedule falls through to the every-other-day
// branch, which needs a createdAt anchor it does not have — so it would be
// dropped before the engine ever saw it, and these tests would pass for the
// wrong reason.
function workoutItem(id, completions = []) {
  return { id, kind: 'workout', title: 'Leg day', schedule: 'daily', active: true, endsOn: null, completions };
}
function doneOn(date) {
  return [{ localDate: date, how: 'manual', late: false }];
}
function session(localDate, type = 'strength', endedAt = `${localDate}T10:00:00Z`) {
  return { id: 99, userId: USER, localDate, type, endedAt };
}
const lineFor = (day, key) => day.breakdown.find((l) => l.key === key);

// --- unplanned workouts --------------------------------------------------
//
// The engine has always had a POINTS.unplannedWorkout line, and it was
// unreachable: nothing ever passed `unplannedWorkout`, so it defaulted to false
// and the points were dead code. A user who trained on a rest day, or who
// skipped the plan and trained anyway, got nothing for the session they did.

test('a session on a rest day scores as an extra workout', async () => {
  const prisma = mockPrisma({ target: TARGET, sessions: [session(TODAY)] });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.ok(lineFor(day, 'workout_unplanned'), 'the extra session is worth points');
});

test('an abandoned session scores nothing', async () => {
  // endedAt is null on a draft the user started and walked away from. Paying for
  // it would reward opening the app.
  const prisma = mockPrisma({
    target: TARGET,
    sessions: [session(TODAY, 'strength', null)],
  });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(lineFor(day, 'workout_unplanned'), undefined);
});

test('a logged rest day is not an extra workout', async () => {
  // type='rest' is the schema's own record of a deliberate rest day. Scoring it
  // as extra effort would pay points for resting, in a system built so the
  // score never punishes rest.
  const prisma = mockPrisma({ target: TARGET, sessions: [session(TODAY, 'rest')] });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(lineFor(day, 'workout_unplanned'), undefined);
});

test('a session on another day does not leak into this one', async () => {
  const prisma = mockPrisma({
    target: TARGET,
    sessions: [session('2026-09-20'), session('2026-09-27')],
  });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(lineFor(day, 'workout_unplanned'), undefined);
});

test('completing the planned workout pays the planned rate, not the extra rate', async () => {
  // Both lines are never on the same day, and this asserts the higher-value one
  // wins — paying 8 for an "extra" workout the user already got 15 for would
  // be double-paying for one session.
  const prisma = mockPrisma({
    target: TARGET,
    planItems: [workoutItem(1, doneOn(TODAY))],
    sessions: [session(TODAY)],
  });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.ok(lineFor(day, 'item_done_1'), 'the planned item is paid');
  assert.equal(lineFor(day, 'workout_unplanned'), undefined);
});

test('training when the plan said to train but it was never ticked off still pays', async () => {
  // The distinction that was being lost. A scheduled workout that was never
  // completed is not a workout done, so the session is genuinely extra — and
  // this is the user the line exists for. Guarding on "was a workout scheduled"
  // instead of "was one done" meant anyone with a workout item in their plan
  // could never earn it, however they actually trained.
  const prisma = mockPrisma({
    target: TARGET,
    planItems: [workoutItem(1)],          // scheduled, no completions
    sessions: [session('2026-09-27')],
  });
  // closeDay, not previewDay: misses are only computed for a closed day
  // (`closed: localDate < today`), so previewing today would show the extra
  // workout with no miss against it and the assertion below would fail for a
  // reason that has nothing to do with this feature.
  const day = await closeDay(prisma, { userId: USER, localDate: '2026-09-27', today: TODAY });
  assert.ok(lineFor(day, 'workout_unplanned'));
  assert.equal(lineFor(day, 'item_done_1'), undefined, 'the unticked item is not paid');
  // The missed item still costs points. An extra session does not buy off a
  // missed plan item, or "just train instead" becomes the optimal strategy.
  assert.ok(lineFor(day, 'workout_missed').points < 0);
});

test('an extra workout is worth less than the plan, always', async () => {
  // The stated reason the rate is lower: the score must not reward ignoring the
  // plan in favour of improvising.
  const done = await previewDay(
    mockPrisma({ target: TARGET, planItems: [workoutItem(1, doneOn(TODAY))], sessions: [session(TODAY)] }),
    { userId: USER, localDate: TODAY, today: TODAY },
  );
  const extra = await previewDay(
    mockPrisma({ target: TARGET, sessions: [session(TODAY)] }),
    { userId: USER, localDate: TODAY, today: TODAY },
  );
  assert.ok(
    lineFor(extra, 'workout_unplanned').points < lineFor(done, 'item_done_1').points,
  );
});

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
