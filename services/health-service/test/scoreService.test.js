import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDay,
  getCalmSeries,
  getSafetyFlag,
  getScoreSeries,
  previewDay,
  setCalmMode,
  isPausedOn,
  getPauseState,
  setPause,
  clearPause,
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
      // clearPause and setCalmMode use this so a missing row is a count of zero
      // rather than a Prisma P2025. Without it in the mock, the suite passed while
      // the real endpoint threw that error at a client.
      updateMany: async (a) => {
        state.updated.push(a.data);
        return { count: goal ? 1 : 0 };
      },
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

// --- Pause ------------------------------------------------------------------
//
// The engine tests prove a paused day is neutral. These prove the pause is
// bounded, cannot be backdated, and lands on the right calendar dates - the
// failure modes that are invisible in the score and obvious to the user.

test('isPausedOn is inclusive at both ends', async () => {
  const goal = { pausedFrom: '2026-09-29', pausedUntil: '2026-10-05' };
  assert.equal(isPausedOn(goal, '2026-09-28'), false, 'the day before is not paused');
  assert.equal(isPausedOn(goal, '2026-09-29'), true, 'the first day is paused');
  assert.equal(isPausedOn(goal, '2026-10-05'), true, 'the last day is paused');
  assert.equal(isPausedOn(goal, '2026-10-06'), false, 'the day after is not');
});

test('isPausedOn treats a half-written pause as no pause, not as open-ended', async () => {
  // A goal row with only one bound set must not pause the user indefinitely. An
  // unbounded pause is the exact thing MAX_PAUSE_DAYS exists to prevent, and a
  // missing column reading as "no end" would hand it out for free.
  assert.equal(isPausedOn({ pausedFrom: '2026-09-29' }, '2027-06-01'), false);
  assert.equal(isPausedOn({ pausedUntil: '2026-10-05' }, '2026-09-01'), false);
  assert.equal(isPausedOn({}, '2026-09-29'), false);
  assert.equal(isPausedOn(null, '2026-09-29'), false);
});

test('an expired pause stops being paused on its own, with nothing to clear it', async () => {
  // Deliberately not requiring a cron or a lazy expiry write. The pause lapses
  // because the comparison is against today, so a user who abandoned the app
  // mid-pause is scored normally again the moment the window passes.
  const goal = { pausedFrom: '2026-09-01', pausedUntil: '2026-09-10' };
  assert.equal(isPausedOn(goal, '2026-09-09'), true);
  assert.equal(isPausedOn(goal, '2026-09-11'), false);
});

test('a pause longer than the cap is clamped, and says it was clamped', async () => {
  const prisma = mockPrisma({ goal: { calmMode: false } });
  const out = await setPause(prisma, { userId: USER, days: 30, today: '2026-09-29' });
  assert.equal(out.pausedFrom, '2026-09-29');
  // 14 inclusive days from 29 Sep is 12 Oct, so this also pins the off-by-one:
  // days=14 must not produce a 15th day.
  assert.equal(out.pausedUntil, '2026-10-12');
  assert.equal(out.maxDays, 14);
  assert.equal(out.capped, true, 'the client needs to know it got less than it asked for');
});

test('a pause of exactly the cap is not reported as clamped', async () => {
  const prisma = mockPrisma({ goal: { calmMode: false } });
  const out = await setPause(prisma, { userId: USER, days: 14, today: '2026-09-29' });
  assert.equal(out.capped, false);
  assert.equal(out.pausedUntil, '2026-10-12');
});

test('a pause crossing a month boundary lands on the right date', async () => {
  // The reason the pause arithmetic exists in the service instead of being done
  // as a Date. 30 Sep + 3 days is 3 Oct, and a naive local-midnight calculation
  // can land on 2 Oct or 4 Oct depending on the timezone it was written in.
  const prisma = mockPrisma({ goal: { calmMode: false } });
  const out = await setPause(prisma, { userId: USER, days: 3, today: '2026-09-30' });
  assert.equal(out.pausedUntil, '2026-10-02', 'three inclusive days from 30 Sep ends 2 Oct');
});

test('a single-day pause ends today, not tomorrow', async () => {
  // daysLeft is inclusive, so a one-day pause is 1 and ends on the day it
  // started. A pause that silently lasted an extra day would be the kind of
  // thing that reads as the app having opinions about your holiday.
  const prisma = mockPrisma({ goal: { calmMode: false } });
  const out = await setPause(prisma, { userId: USER, days: 1, today: '2026-09-29' });
  assert.equal(out.pausedUntil, '2026-09-29');
  assert.equal(out.daysLeft, 1);
});

test('a pause cannot be started with a malformed date', async () => {
  // This is the one that would have shipped as a silent lie: a window starting
  // on a date no day ever matches, reported to the user as an active pause,
  // while their score kept falling.
  const prisma = mockPrisma({ goal: { calmMode: false } });
  await assert.rejects(
    () => setPause(prisma, { userId: USER, days: 7, today: '2026-13-45' }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    () => setPause(prisma, { userId: USER, days: 7, today: undefined }),
    /YYYY-MM-DD/,
  );
  assert.equal(prisma.state.updated.length, 0, 'a rejected pause must not write');
});

test('a pause in progress cannot be backdated', async () => {
  // Every day before today is already frozen into a snapshot, so a backdated
  // pause could not take effect even if accepted - and accepting it would
  // promise something the score cannot deliver.
  const prisma = mockPrisma({ goal: { calmMode: false, pausedFrom: '2026-09-20', pausedUntil: '2026-10-01' } });
  await assert.rejects(
    () => setPause(prisma, { userId: USER, days: 7, today: '2026-09-29' }),
    /backdated/,
  );
});

test('an expired pause can be replaced with a fresh one', async () => {
  // Only an IN PROGRESS pause is protected. Someone whose pause ran out and
  // wants to start another must not be locked out of the feature.
  const prisma = mockPrisma({ goal: { calmMode: false, pausedFrom: '2026-09-01', pausedUntil: '2026-09-10' } });
  const out = await setPause(prisma, { userId: USER, days: 7, today: '2026-09-29' });
  assert.equal(out.pausedFrom, '2026-09-29');
});

test('closing a paused day freezes a flat snapshot marked paused', async () => {
  // Flat in the stored row, not just in the computed object: this is what the
  // chart reads, and a flat row without the flag would be indistinguishable from
  // a user who genuinely did nothing that day.
  const prisma = mockPrisma({
    goal: { calmMode: false, pausedFrom: '2026-09-28', pausedUntil: '2026-10-05' },
    snapshots: [{ userId: USER, localDate: '2026-09-27', close: 210, open: 200, high: 220, low: 190 }],
    planItems: [workoutItem(1)],
    target: TARGET,
  });
  const row = await closeDay(prisma, { userId: USER, localDate: '2026-09-28', today: TODAY });
  assert.equal(row.paused, true);
  assert.equal(row.close, 210, 'the close carries the previous day forward');
  assert.equal(row.open, 210);
  assert.equal(row.high, 210);
  assert.equal(row.low, 210);
  assert.deepEqual(row.breakdown, []);
});

test('closing an ordinary day is not marked paused', async () => {
  const prisma = mockPrisma({
    goal: { calmMode: false },
    snapshots: [{ userId: USER, localDate: '2026-09-27', close: 210, open: 200, high: 220, low: 190 }],
    planItems: [workoutItem(1, doneOn('2026-09-28'))],
    target: TARGET,
  });
  const row = await closeDay(prisma, { userId: USER, localDate: '2026-09-28', today: TODAY });
  assert.equal(row.paused, false);
  // Not 'the close went up'. This mock returns no food logs against a 2000 kcal
  // target, so an ordinary day here is legitimately NEGATIVE - the aggregate
  // rules charge calories-off-target and protein-short. The claim worth pinning
  // is the contrast with the paused test above: an ordinary day was actually
  // scored, so it has a breakdown and is not a flat pass-through.
  assert.ok(row.breakdown.length > 0, 'an ordinary day is scored, not passed through');
  assert.notEqual(row.close, row.open, 'an ordinary day is not flat');
});

test('getPauseState reports an active pause with days left', async () => {
  const prisma = mockPrisma({ goal: { calmMode: false, pausedFrom: '2026-09-29', pausedUntil: '2026-10-05' } });
  const out = await getPauseState(prisma, { userId: USER, today: '2026-09-29' });
  assert.equal(out.active, true);
  assert.equal(out.daysLeft, 7, 'inclusive: 29 Sep to 5 Oct is seven days');
  assert.equal(out.maxDays, 14);
});

test('getPauseState reports an expired pause as inactive and not as days left', async () => {
  const prisma = mockPrisma({ goal: { calmMode: false, pausedFrom: '2026-09-01', pausedUntil: '2026-09-10' } });
  const out = await getPauseState(prisma, { userId: USER, today: '2026-09-20' });
  assert.equal(out.active, false);
  assert.equal(out.daysLeft, 0, 'an expired pause must not show a countdown');
});

test('clearing the pause ends it immediately', async () => {
  const prisma = mockPrisma({ goal: { calmMode: false, pausedFrom: '2026-09-29', pausedUntil: '2026-10-05' } });
  const out = await clearPause(prisma, { userId: USER });
  assert.equal(out.active, false);
  assert.deepEqual(
    { from: prisma.state.updated.at(-1).pausedFrom, until: prisma.state.updated.at(-1).pausedUntil },
    { from: null, until: null },
  );
});

test('calm mode carries the paused flag through the flattened series', async () => {
  // Calm mode flattens every value, which would erase the one thing that
  // explains why nothing moved. The flag is not a value, so it survives.
  const prisma = mockPrisma({
    goal: { calmMode: true },
    snapshots: [
      { userId: USER, localDate: '2026-09-28', close: 210, open: 200, high: 220, low: 190, paused: false },
      { userId: USER, localDate: '2026-09-29', close: 210, open: 210, high: 210, low: 210, paused: true },
    ],
  });
  const out = await getCalmSeries(prisma, { userId: USER });
  assert.equal(out.calmMode, true);
  assert.equal(out.series[0].paused, false);
  assert.equal(out.series[1].paused, true, 'a paused day must still be identifiable in calm mode');
});


// --- open actions on the day payload -----------------------------------------
//
// The shaping and ordering are tested in remediation.test.js, including the
// guarantee that every actionable kind has copy. What is asserted here is the
// wiring: that the day the app already fetches carries its own list, and that a
// frozen day does not.

test('an open day carries what is still open, with the user\'s own wording', async () => {
  const prisma = mockPrisma({
    planItems: [workoutItem(1)],
    target: TARGET,
  });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });

  assert.equal(day.openActions.length, 1);
  // The label is the plan item's title, not a restatement of the kind. "Leg day"
  // is the thing the user wrote and the thing they recognise.
  assert.equal(day.openActions[0].label, 'Leg day');
  assert.equal(day.openActions[0].kind, 'workout');
  assert.equal(day.openActions[0].itemId, 1);
});

test('a ticked item drops out of the open list', async () => {
  const prisma = mockPrisma({
    planItems: [workoutItem(1, [doneOn(TODAY)])],
    target: TARGET,
  });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.deepEqual(day.openActions, []);
});

test('a day with nothing left open carries an empty list, not a missing field', async () => {
  const prisma = mockPrisma({
    planItems: [workoutItem(1, [doneOn(TODAY)])],
    target: TARGET,
  });
  const day = await previewDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.ok(Array.isArray(day.openActions), 'the field must always be present');
  assert.deepEqual(day.openActions, []);
});

test('a day in the past previews with no open items, because it is already frozen', async () => {
  // A preview of yesterday is a historical read. Offering work on it would be
  // an action against a day that will never be recomputed, which is the same
  // dead end this whole module was rebuilt to avoid.
  const prisma = mockPrisma({ planItems: [workoutItem(1)], target: TARGET });
  const day = await previewDay(prisma, { userId: USER, localDate: '2026-09-27', today: TODAY });
  assert.deepEqual(day.openActions, []);
});

test('closing a day returns no open items, on both the fresh and the retry path', async () => {
  const prisma = mockPrisma({ planItems: [workoutItem(1)], target: TARGET });
  const first = await closeDay(prisma, { userId: USER, localDate: TODAY, today: TODAY });
  assert.deepEqual(first.openActions, [], 'closing a day must not return open items');

  // The retry path returns the stored row rather than recomputing. Without an
  // explicit empty list the field would be absent here, and a client could not
  // tell "nothing open" apart from "response from before the field existed".
  const snapshot = { userId: USER, localDate: TODAY, open: 0, high: 0, low: 0, close: 0, breakdown: [] };
  const prisma2 = mockPrisma({ snapshots: [snapshot] });
  const second = await closeDay(prisma2, { userId: USER, localDate: TODAY, today: TODAY });
  assert.equal(second.alreadyClosed, true);
  assert.deepEqual(second.openActions, []);
});

// --- no goal row ---------------------------------------------------------------
//
// Same cause as the score target's: these columns live on HealthGoal, which the
// intake wizard creates, and the ledger is reachable without intake. All of this
// was live on the deployed endpoint and found by calling it rather than reading it.

test('starting a pause with no goal is a 409 with a code, not a 500', async () => {
  // A bare Error reaches the client as "Server error". The request was
  // well-formed; the state cannot hold it yet.
  await assert.rejects(
    () => setPause(mockPrisma({ goal: null }), { userId: USER, days: 3, today: TODAY }),
    (err) => {
      assert.equal(err.name, 'NoGoalError');
      assert.equal(err.status, 409);
      assert.equal(err.code, 'NO_GOAL');
      return true;
    },
  );
});

test('resuming with no goal succeeds instead of leaking Prisma P2025', async () => {
  const out = await clearPause(mockPrisma({ goal: null }), { userId: USER });
  assert.equal(out.active, false);
  assert.equal(out.hasGoal, false);
});

test('resuming is idempotent', async () => {
  const prisma = mockPrisma({ goal: { userId: USER, pausedFrom: '2026-09-20', pausedUntil: '2026-09-22' } });
  const first = await clearPause(prisma, { userId: USER });
  const second = await clearPause(prisma, { userId: USER });
  assert.deepEqual(second, first);
});

test('the pause read tells "no goal" apart from "not paused"', async () => {
  const noGoal = await getPauseState(mockPrisma({ goal: null }), { userId: USER, today: TODAY });
  const notPaused = await getPauseState(mockPrisma({ goal: { userId: USER } }), { userId: USER, today: TODAY });
  assert.equal(noGoal.hasGoal, false);
  assert.equal(noGoal.active, false);
  assert.equal(notPaused.hasGoal, true);
  assert.equal(notPaused.active, false);
});

test('calm mode on a user with no goal records nothing and does not throw', async () => {
  // Deliberately NOT a 409, unlike the window-creating writes. Calm mode is a
  // protection; refusing to record that somebody asked for it because their setup
  // is incomplete would be protecting them from the wrong thing. A user with no
  // goal has no days being scored, so there is nothing for it to apply to.
  const out = await setCalmMode(mockPrisma({ goal: null }), { userId: USER, calmMode: true });
  // Off, not on. The client renders this echo rather than the tap, on purpose, so
  // a user with no goal row would see calm mode switch on, stay on, and be gone
  // again by the next launch. The write is allowed to be a no-op; the response is
  // not allowed to pretend otherwise.
  assert.equal(out.calmMode, false, 'reports what is stored, not what was asked for');
  assert.equal(out.applied, false, 'honest about having had nowhere to write it');

  const applied = await setCalmMode(mockPrisma({ goal: { userId: USER } }), { userId: USER, calmMode: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.calmMode, true, 'a stored preference is echoed back');
});

test('calm mode echoes the stored value when a goal row exists', async () => {
  // The other direction of the same rule, and the one a regression here would
  // most likely break: a user who turns it OFF must be told off, not on.
  const off = await setCalmMode(mockPrisma({ goal: { userId: USER } }), { userId: USER, calmMode: false });
  assert.equal(off.calmMode, false);
  assert.equal(off.applied, true);
});

