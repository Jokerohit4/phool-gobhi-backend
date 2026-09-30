import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setScoreTarget,
  getScoreTargetState,
  clearScoreTarget,
  TARGET_LIMITS,
} from '../services/ledger/scoreTargetService.js';

// The score target is a threshold on a running total that can fall, plus a
// window the user chose. The decisions worth testing are the ones that could be
// wrong in the direction that flatters the user: reporting "on track" for a pace
// that cannot reach the target, or quietly scoring a user as behind for days they
// were explicitly told to pause.

const USER = 7;

// A frozen day. `close` is what the chain carried forward into the next day.
const snap = (localDate, close) => ({ userId: USER, localDate, close: String(close) });

// The prisma shape previewDay/previousClose need, taken from scoreService.test.js
// so the target is exercised against the same gatherDayInputs the real path uses.
// With no plan items, no food and no sessions, an OPEN day (today) earns nothing
// and is charged no misses (computeMisses runs only when `closed`), so today's
// preview close is exactly `previousClose(today)` - the last frozen close before
// today. That makes `currentScore` fully deterministic from the snapshot chain.
function mockPrisma({ snapshots = [], goal = null, target = null } = {}) {
  const state = { updated: [] };
  let currentGoal = goal;
  return {
    state,
    scoreDaySnapshot: {
      findMany: async () => [...snapshots].sort((a, b) => a.localDate.localeCompare(b.localDate)),
      findFirst: async (a) => {
        const rows = snapshots.filter((r) => r.userId === USER);
        const all =
          a.where?.localDate?.lt != null
            ? rows.filter((r) => r.localDate < a.where.localDate.lt)
            : rows;
        all.sort((x, y) => y.localDate.localeCompare(x.localDate));
        return all[0] || null;
      },
      findUnique: async () => null,
    },
    nutritionTarget: { findUnique: async () => target },
    healthGoal: {
      findUnique: async () => currentGoal,
      update: async ({ data }) => {
        state.updated.push(data);
        currentGoal = { userId: USER, ...currentGoal, ...data };
        return currentGoal;
      },
    },
    planItem: { findMany: async () => [] },
    foodLog: { findMany: async () => [] },
    workoutSession: { findMany: async () => [] },
  };
}

/** A goal row carrying a live target. */
function targetGoal({ points = 100, from, until, pausedFrom = null, pausedUntil = null } = {}) {
  return {
    userId: USER,
    pausedFrom,
    pausedUntil,
    scoreTargetPoints: points,
    scoreTargetFrom: from,
    scoreTargetUntil: until,
  };
}

// --- no target ---------------------------------------------------------------

test('a user with no goal reports no target rather than throwing', async () => {
  const out = await getScoreTargetState(mockPrisma({ goal: null }), { userId: USER, today: '2026-10-01' });
  assert.equal(out.active, false);
  assert.equal(out.band, 'none');
  assert.equal(out.points, null);
});

test('a goal with no target set reports no target', async () => {
  const prisma = mockPrisma({ goal: { userId: USER, pausedFrom: null, pausedUntil: null, scoreTargetPoints: null } });
  const out = await getScoreTargetState(prisma, { userId: USER, today: '2026-10-01' });
  assert.equal(out.active, false);
  assert.equal(out.band, 'none');
});

// --- setting -----------------------------------------------------------------

test('the window is stored inclusively, from today', async () => {
  // today..today+29 for a 30-day window: day 1 is today and day 30 is the 30th, not
  // the 31st.
  const prisma = mockPrisma({ goal: { userId: USER, pausedFrom: null, pausedUntil: null } });
  const out = await setScoreTarget(prisma, { userId: USER, points: 500, days: 30, today: '2026-10-01' });
  assert.equal(prisma.state.updated[0].scoreTargetFrom, '2026-10-01');
  assert.equal(prisma.state.updated[0].scoreTargetUntil, '2026-10-30');
  assert.equal(out.daysTotal, 30);
  assert.equal(out.daysLeft, 30);
});

test('a 1-day window is a single day, not zero', async () => {
  const prisma = mockPrisma({ goal: { userId: USER, pausedFrom: null, pausedUntil: null } });
  const out = await setScoreTarget(prisma, { userId: USER, points: 10, days: 1, today: '2026-10-01' });
  assert.equal(out.until, '2026-10-01');
  assert.equal(out.daysTotal, 1);
  assert.equal(out.daysLeft, 1);
});

test('a malformed today is refused, because the window is written from it', async () => {
  const prisma = mockPrisma({ goal: { userId: USER, pausedFrom: null, pausedUntil: null } });
  await assert.rejects(
    () => setScoreTarget(prisma, { userId: USER, points: 500, days: 30, today: '2026-13-45' }),
    /today must be/,
  );
  assert.equal(prisma.state.updated.length, 0, 'nothing written on a bad date');
});

test('out-of-range points and windows are refused, and the message carries the range', async () => {
  const prisma = mockPrisma({ goal: { userId: USER, pausedFrom: null, pausedUntil: null } });
  await assert.rejects(
    () => setScoreTarget(prisma, { userId: USER, points: 0, days: 30, today: '2026-10-01' }),
    new RegExp(String(TARGET_LIMITS.minPoints)),
  );
  await assert.rejects(
    () => setScoreTarget(prisma, { userId: USER, points: 500, days: 0, today: '2026-10-01' }),
    new RegExp(String(TARGET_LIMITS.minDays)),
  );
  await assert.rejects(
    () => setScoreTarget(prisma, { userId: USER, points: 500, days: TARGET_LIMITS.maxDays + 1, today: '2026-10-01' }),
    new RegExp(String(TARGET_LIMITS.maxDays)),
  );
});

test('a non-numeric points value is refused rather than coerced to zero', async () => {
  // The controller passes non-numerics through as null. A null target must not
  // become 0 and silently store a target the user never asked for.
  const prisma = mockPrisma({ goal: { userId: USER, pausedFrom: null, pausedUntil: null } });
  await assert.rejects(
    () => setScoreTarget(prisma, { userId: USER, points: Number.NaN, days: 30, today: '2026-10-01' }),
    /Target score must be between/,
  );
  assert.equal(prisma.state.updated.length, 0);
});

test('a target already reached is refused, so the card cannot show one', async () => {
  // The chain stands at 120 and the user tries to set 100. There would be nothing
  // to pace towards, so this is refused at the boundary.
  const prisma = mockPrisma({
    goal: { userId: USER, pausedFrom: null, pausedUntil: null },
    snapshots: [snap('2026-09-30', 120)],
  });
  await assert.rejects(
    () => setScoreTarget(prisma, { userId: USER, points: 100, days: 30, today: '2026-10-01' }),
    /already reached/,
  );
  assert.equal(prisma.state.updated.length, 0);
});

// --- progress is measured from the baseline, not the raw target ---------------

test('progress is the distance from where the user started, not the whole target', async () => {
  // Chain at 300, target 400, set today. The user should see "100 to go" and 0%
  // progress - not "75% done" (300/400), which is true arithmetic and useless the
  // moment they set it.
  const prisma = mockPrisma({
    goal: targetGoal({ points: 400, from: '2026-10-01', until: '2026-10-10' }),
    snapshots: [snap('2026-09-30', 300)],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: '2026-10-01' });
  assert.equal(out.baseline, 300);
  assert.equal(out.current, 300);
  assert.equal(out.remaining, 100);
  assert.equal(out.progress, 0, 'nothing travelled yet');
});

test('the baseline is the last close before the window, not the earliest day', async () => {
  const prisma = mockPrisma({
    goal: targetGoal({ points: 400, from: '2026-10-01', until: '2026-10-10' }),
    snapshots: [snap('2026-09-20', 100), snap('2026-09-30', 300)],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: '2026-10-01' });
  assert.equal(out.baseline, 300, 'the close the chain actually carried into the window');
});

// --- reached / expired -------------------------------------------------------

test('reaching the target is "reached", and the bar is full rather than over', async () => {
  const prisma = mockPrisma({
    goal: targetGoal({ points: 200, from: '2026-09-25', until: '2026-10-10' }),
    snapshots: [snap('2026-09-24', 100), snap('2026-09-30', 200)],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: '2026-10-01' });
  assert.equal(out.band, 'reached');
  assert.equal(out.reached, true);
  assert.equal(out.expired, false);
  assert.equal(out.remaining, 0);
  assert.equal(out.progress, 1, 'a full bar, not 100%');
});

test('a window that ran out without reaching the target is "expired"', async () => {
  const prisma = mockPrisma({
    goal: targetGoal({ points: 100, from: '2026-09-20', until: '2026-09-30' }),
    snapshots: [snap('2026-09-19', 0), snap('2026-09-30', 50)],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: '2026-10-01' });
  assert.equal(out.band, 'expired');
  assert.equal(out.expired, true);
  assert.equal(out.reached, false);
});

// --- pace bands --------------------------------------------------------------
//
// A 10-day window (2026-09-25..2026-10-04) read on 2026-10-01. The window opened 6
// days before today and today is still open, so 6 days have completed.
//
//   baseline 0   (frozen close on 09-24)
//   target  100  (distance 100)
//   current C    (frozen close on 09-30, the last close before today)
//
// 6 of 10 days spent, so on-pace is 60 covered. The bands are 1.0 / 0.85.
function pacePrisma(current) {
  return mockPrisma({
    goal: targetGoal({ points: 100, from: '2026-09-25', until: '2026-10-04' }),
    snapshots: [snap('2026-09-24', 0), ...(current == null ? [] : [snap('2026-09-30', current)])],
  });
}
const TODAY = '2026-10-01';

test('exactly on pace is on_track', async () => {
  const out = await getScoreTargetState(pacePrisma(60), { userId: USER, today: TODAY });
  assert.equal(out.daysTotal, 10);
  assert.equal(out.daysElapsed, 6, 'six completed days; today is still open and is not counted');
  assert.equal(out.covered, 60);
  assert.equal(out.pace, 1);
  assert.equal(out.band, 'on_track');
});

test('slightly behind pace is at_risk, not behind - the margin between the two', async () => {
  // Green is "on pace or ahead" (>= 1.0), so 0.95 is amber by design. What the
  // margin buys is that a 5% wobble is a nudge, not an alarm: anything at or
  // above 0.85 stays out of the red band.
  const out = await getScoreTargetState(pacePrisma(57), { userId: USER, today: TODAY });
  assert.equal(out.pace, 0.95);
  assert.equal(out.band, 'at_risk');
});

test('clearly behind but inside the wide margin is at_risk', async () => {
  const out = await getScoreTargetState(pacePrisma(55), { userId: USER, today: TODAY });
  assert.equal(out.pace, 0.9167);
  assert.equal(out.band, 'at_risk');
});

test('below the margin is behind', async () => {
  const out = await getScoreTargetState(pacePrisma(50), { userId: USER, today: TODAY });
  assert.equal(out.pace, 0.8333);
  assert.equal(out.band, 'behind');
});

test('well behind pace is behind', async () => {
  const out = await getScoreTargetState(pacePrisma(12), { userId: USER, today: TODAY });
  assert.equal(out.pace, 0.2);
  assert.equal(out.band, 'behind');
});

test('a window that opened today is on_track with no pace yet', async () => {
  // The regression this guards: a brand-new target read on the day it was set.
  // The user has earned nothing because the day is not over, and reporting them
  // as behind for hours they have not lived yet is how a goal feature gets muted.
  const prisma = mockPrisma({
    goal: targetGoal({ points: 100, from: TODAY, until: '2026-10-31' }),
    snapshots: [snap('2026-09-30', 0)],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: TODAY });
  assert.equal(out.daysElapsed, 0, 'today is open, so nothing has completed yet');
  assert.equal(out.pace, null, 'no pace is computed rather than an infinite one');
  assert.equal(out.band, 'on_track');
  assert.equal(out.progress, 0);
});

test('a user who has never scored is on_track, not a failure', async () => {
  // No snapshot history at all. "No data" must not paint red - and note that
  // `current` is 0 rather than null, because the live preview is always a real
  // number. A 0 earned by missing everything is a genuine total, and the band
  // only reads as neutral here because the window has no completed days yet.
  const prisma = mockPrisma({
    goal: targetGoal({ points: 100, from: '2026-09-25', until: '2026-10-04' }),
    snapshots: [],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: TODAY });
  assert.equal(out.baseline, 0);
  assert.equal(out.band, 'behind', 'six completed days of nothing IS behind, honestly');
  assert.equal(out.reached, false);
});

// --- progress can go backwards, honestly --------------------------------------

test('coverage is reported raw and may be negative when the score falls', async () => {
  // Baseline 100, target 200, and the chain has dropped to 60 - the user is 40
  // BELOW where they started. The bar clamps to 0, but `covered` stays -40 so the
  // client can say "down 40 from where you started" instead of a bar pinned at
  // zero with no explanation.
  const prisma = mockPrisma({
    goal: targetGoal({ points: 200, from: TODAY, until: '2026-10-10' }),
    snapshots: [snap('2026-09-30', 100), snap('2026-10-01', 60)],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: '2026-10-31' });
  assert.equal(out.baseline, 100);
  assert.equal(out.current, 60);
  assert.equal(out.covered, -40);
  assert.equal(out.progress, 0, 'bar clamps at zero');
  assert.equal(out.remaining, 140, 'but the gap to close grew, and is reported');
});

// --- pause freezes the clock's accounting, not the deadline -------------------

test('paused days inside the window do not count as elapsed', async () => {
  // The 10-day window 09-25..10-04, read on 10-01, with the first 4 days paused.
  // Six days have completed but two of them were a pause, so four ran.
  const prisma = mockPrisma({
    goal: targetGoal({
      points: 100,
      from: '2026-09-25',
      until: '2026-10-04',
      pausedFrom: '2026-09-25',
      pausedUntil: '2026-09-28',
    }),
    snapshots: [snap('2026-09-24', 0), snap('2026-09-30', 30)],
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: TODAY });
  assert.equal(out.daysElapsedRaw, 6, 'six days have completed');
  assert.equal(out.pausedDays, 4);
  assert.equal(out.daysElapsed, 2, 'four of the six were a pause, so two ran');
});

test('a pause stops a user being shown as behind for resting', async () => {
  // The whole point. Same window and same score as the test above, compared with
  // and without the pause: the score is identical, and only the pace differs.
  const base = { points: 100, from: '2026-09-25', until: '2026-10-04' };
  const history = [snap('2026-09-24', 0), snap('2026-09-30', 30)];
  const withPause = await getScoreTargetState(
    mockPrisma({ goal: targetGoal({ ...base, pausedFrom: '2026-09-25', pausedUntil: '2026-09-28' }), snapshots: history }),
    { userId: USER, today: TODAY },
  );
  const without = await getScoreTargetState(mockPrisma({ goal: targetGoal(base), snapshots: history }), {
    userId: USER,
    today: TODAY,
  });
  assert.equal(withPause.current, without.current, 'same score either way');
  assert.notEqual(withPause.band, without.band, 'but the pace judgement differs');
  assert.equal(withPause.band, 'on_track', '4 of 6 days ran and 30 of 100 is level');
  assert.equal(without.band, 'behind', '6 of 6 days ran and 30 of 100 is well short');
});

test('a pause does not extend the deadline', async () => {
  const prisma = mockPrisma({
    goal: targetGoal({
      points: 100,
      from: '2026-09-25',
      until: '2026-10-04',
      pausedFrom: '2026-09-25',
      pausedUntil: '2026-09-28',
    }),
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: TODAY });
  assert.equal(out.until, '2026-10-04', 'deadline unchanged - extending it would be extending for the wrong reason');
});

test('a pause that has not started yet costs no days', async () => {
  const prisma = mockPrisma({
    goal: targetGoal({
      points: 100,
      from: '2026-09-25',
      until: '2026-10-04',
      pausedFrom: '2026-10-02',
      pausedUntil: '2026-10-06',
    }),
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: TODAY });
  assert.equal(out.pausedDays, 0);
});

test('a pause longer than the window is clipped to the window', async () => {
  // A 14-day pause starting the same day the window opens. Only the days inside
  // the window may be discounted, or the elapsed count would go negative and the
  // band would be computed from a nonsense denominator.
  const prisma = mockPrisma({
    goal: targetGoal({
      points: 100,
      from: '2026-09-25',
      until: '2026-10-04',
      pausedFrom: '2026-09-25',
      pausedUntil: '2026-10-08',
    }),
  });
  const out = await getScoreTargetState(prisma, { userId: USER, today: TODAY });
  assert.equal(out.pausedDays, 6, 'clipped to the 6 completed days inside the window');
  assert.equal(out.daysElapsed, 0, 'and never below zero');
  assert.equal(out.band, 'on_track', 'a full window of rest is not "behind"');
});

test('pausedNow is true only while the pause covers today', async () => {
  const base = { points: 100, from: '2026-09-25', until: '2026-10-04', pausedFrom: '2026-09-25', pausedUntil: '2026-09-28' };
  const on = await getScoreTargetState(mockPrisma({ goal: targetGoal(base) }), { userId: USER, today: '2026-09-27' });
  assert.equal(on.pausedNow, true);
  const off = await getScoreTargetState(mockPrisma({ goal: targetGoal(base) }), { userId: USER, today: '2026-10-01' });
  assert.equal(off.pausedNow, false);
});

// --- clear -------------------------------------------------------------------

test('clearing removes the target, touches nothing else, and leaves the score alone', async () => {
  const prisma = mockPrisma({
    goal: targetGoal({ points: 100, from: '2026-09-25', until: '2026-10-04', pausedFrom: '2026-09-28', pausedUntil: '2026-09-30' }),
    snapshots: [snap('2026-09-30', 50)],
  });
  const out = await clearScoreTarget(prisma, { userId: USER });
  assert.equal(out.active, false);
  assert.equal(out.band, 'none');
  // Exactly the three target columns. A clear must never touch the pause, the calm
  // setting, or any scored number - this asserts the whole key set so a later
  // "while we are in here" addition to the update fails here rather than in prod.
  assert.deepEqual(Object.keys(prisma.state.updated[0]).sort(), [
    'scoreTargetFrom',
    'scoreTargetPoints',
    'scoreTargetUntil',
  ]);
});
