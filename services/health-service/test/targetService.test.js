import test from 'node:test';
import assert from 'node:assert/strict';

import {
  latestWeightKg,
  resolveInputs,
  recomputeTargets,
  resolveActivity,
  gatherMeasuredActivity,
  describeActivity,
  MISSING_REASONS,
} from '../services/ledger/targetService.js';
import { MEASURED_ACTIVITY_THRESHOLD_DAYS } from '../services/ledger/constants.js';

const TODAY = '2026-09-28';

/** Offsets a 'YYYY-MM-DD' string by whole days, staying in that format. */
function shift(date, deltaDays) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/** Applies the gte/lte range a Prisma string filter would apply. */
function inRange(value, filter) {
  if (!filter) return true;
  if (filter.gte && value < filter.gte) return false;
  if (filter.lte && value > filter.lte) return false;
  return true;
}

// A hand-rolled Prisma double rather than a mocking library: the queries this
// service makes are three findUnique/findFirst calls, and a stub that returns
// canned rows keeps the test honest about what the service actually asked for.
function fakePrisma({
  goal = null,
  profile = null,
  weight = null,
  targets = [],
  activityRows = [],
  sessions = [],
} = {}) {
  const calls = { created: [] };
  return {
    calls,
    healthGoal: {
      findUnique: async () => goal,
    },
    personalisationProfile: {
      findUnique: async () => profile,
    },
    biometricEntry: {
      findFirst: async () => weight,
    },
    // Modelled because recomputeTargets now gathers measurements itself when the
    // caller does not supply them. Defaulting to empty is the honest default: it
    // is what a user with no watch paired looks like, and it keeps the existing
    // tests exercising the stated-activity path.
    //
    // These honour the `date`/`localDate` range the service asks for. An earlier
    // version ignored it, and a 14-day window silently consumed 28 rows of
    // fixture — which made sessionsPerWeek come out double and hid the very bug
    // these tests exist to catch. A double that ignores the query under test is
    // worse than no double.
    dailyActivityMetric: {
      findMany: async ({ where }) =>
        activityRows.filter((r) => inRange(r.date, where.date)),
    },
    workoutSession: {
      findMany: async ({ where }) =>
        sessions.filter((s) => inRange(s.localDate, where.localDate)),
    },
    nutritionTarget: {
      findFirst: async () => targets[0] ?? null,
      create: async ({ data }) => {
        calls.created.push(data);
        return { id: 1, ...data };
      },
    },
  };
}

const FULL_GOAL = {
  userId: 1,
  goal: 'recomp',
  sex: 'male',
  age: 29,
  heightCm: 175,
  activity: 'moderate',
};

const WEIGHT_READING = { metric: 'weight', value: 70, unit: 'kg', localDate: '2026-09-27' };

// --- Weight resolution -----------------------------------------------------

test('weight comes from the biometric time series, not a setup copy', async () => {
  const prisma = fakePrisma({ weight: WEIGHT_READING });
  const kg = await latestWeightKg({ prisma, userId: 1, localDate: TODAY });
  assert.equal(kg, 70);
});

test('no weight logged means no weight, not a default', async () => {
  const prisma = fakePrisma({ weight: null });
  const kg = await latestWeightKg({ prisma, userId: 1, localDate: TODAY });
  assert.equal(kg, null, 'must return null rather than guessing a body size');
});

test('an implausible weight is refused rather than computed with', async () => {
  // A bad reading produces a target that looks plausible and is meaningless —
  // the worst kind of wrong, because nothing on screen looks broken.
  for (const value of [0, -5, 12, 900, Number.NaN]) {
    const prisma = fakePrisma({ weight: { ...WEIGHT_READING, value } });
    const kg = await latestWeightKg({ prisma, userId: 1, localDate: TODAY });
    assert.equal(kg, null, `${value} should be refused`);
  }
});

test('a weight reading dated in the future is ignored', async () => {
  // Clock skew, or a typo in the date. Accepting it would inflate BMR.
  const prisma = fakePrisma({ weight: { ...WEIGHT_READING, localDate: '2026-10-30' } });
  const kg = await latestWeightKg({ prisma, userId: 1, localDate: TODAY });
  assert.equal(kg, null);
});

test('an older reading is still used when there is nothing newer', async () => {
  const prisma = fakePrisma({ weight: { ...WEIGHT_READING, localDate: '2026-01-01' } });
  const kg = await latestWeightKg({ prisma, userId: 1, localDate: TODAY });
  assert.equal(kg, 70, 'a stale reading beats no reading');
});

// --- Height resolution -----------------------------------------------------

test('height is read from the goal first', async () => {
  const prisma = fakePrisma({
    goal: { ...FULL_GOAL, heightCm: 175 },
    profile: { heightCm: 999 },
    weight: WEIGHT_READING,
  });
  const r = await resolveInputs({ prisma, userId: 1, localDate: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.inputs.heightCm, 175);
  assert.equal(r.heightSource, 'intake');
});

test('height falls back to the legacy profile placeholder', async () => {
  // Users who set up the existing health-metrics feature already answered this.
  // Asking again is how intakes get abandoned.
  const prisma = fakePrisma({
    goal: { ...FULL_GOAL, heightCm: null },
    profile: { heightCm: 180 },
    weight: WEIGHT_READING,
  });
  const r = await resolveInputs({ prisma, userId: 1, localDate: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.inputs.heightCm, 180);
  assert.equal(r.heightSource, 'legacy_profile');
});

test('height is reported missing when neither source has it', async () => {
  const prisma = fakePrisma({
    goal: { ...FULL_GOAL, heightCm: null },
    profile: null,
    weight: WEIGHT_READING,
  });
  const r = await resolveInputs({ prisma, userId: 1, localDate: TODAY });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('height'));
  assert.equal(r.reasons.height, MISSING_REASONS.height);
});

// --- Missing inputs --------------------------------------------------------

test('every missing input is reported at once, with a reason each', async () => {
  // The intake screen asks for all of it in one pass. A service that returned
  // one field at a time would walk the user back through setup repeatedly.
  const prisma = fakePrisma({ goal: { userId: 1, goal: 'recomp' }, profile: null, weight: null });
  const r = await resolveInputs({ prisma, userId: 1, localDate: TODAY });

  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.sort(), ['activity', 'age', 'height', 'sex', 'weight']);
  for (const field of r.missing) {
    assert.ok(r.reasons[field], `${field} has no reason`);
  }
  assert.equal(r.reasons.weight, MISSING_REASONS.weight);
});

test('a user with no goal at all is told exactly that', async () => {
  const prisma = fakePrisma({ goal: null });
  const r = await resolveInputs({ prisma, userId: 1, localDate: TODAY });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['goal']);
});

// --- Activity measurement --------------------------------------------------

test('a guessed activity stands until there are 14 days of data', async () => {
  // A week of three logged walks is not evidence that someone is very active,
  // and overriding their stated level that early would be the service guessing.
  const r = resolveActivity({
    goal: { activity: 'moderate' },
    measuredBurnKcal: 900,
    measuredDays: MEASURED_ACTIVITY_THRESHOLD_DAYS - 1,
  });
  assert.equal(r.activity, 'moderate');
  assert.equal(r.isMeasured, false);
  assert.equal(r.band, null);
});

test('after 14 days, measured activity supersedes the guess', async () => {
  const r = resolveActivity({
    goal: { activity: 'sedentary' },
    measuredBurnKcal: 800,
    measuredDays: MEASURED_ACTIVITY_THRESHOLD_DAYS,
  });
  assert.equal(r.activity, 'very_active');
  assert.equal(r.isMeasured, true);
  assert.equal(r.band, 'very_active');
});

test('a long window with no real burn is treated as no data, not as sedentary', () => {
  // A broken wearable, not a sedentary user. Someone who says they are
  // moderately active but whose watch logged 10 kcal a day has not been
  // wearing it, and overriding their stated level would cut their calorie
  // target on the strength of a device in a drawer. Under-reporting activity is
  // the more damaging direction: it shrinks the target rather than inflating it.
  const r = resolveActivity({
    goal: { activity: 'moderate' },
    measuredBurnKcal: 10,
    measuredDays: 30,
  });
  assert.equal(r.activity, 'moderate');
  assert.equal(r.isMeasured, false);
  assert.equal(r.band, null);
  assert.equal(r.ignoredBecause, 'measured_burn_below_floor');
});

test('a genuine light day still counts as measured', () => {
  // The floor sits below the 'light' threshold, so a real light week is
  // measured rather than dismissed.
  const r = resolveActivity({
    goal: { activity: 'sedentary' },
    measuredBurnKcal: 200,
    measuredDays: 30,
  });
  assert.equal(r.band, 'light');
  assert.equal(r.isMeasured, true);
  assert.equal(r.activity, 'light');
});

// --- Recompute -------------------------------------------------------------

test('a recompute with missing inputs writes nothing', async () => {
  const prisma = fakePrisma({ goal: { userId: 1, goal: 'recomp' }, weight: null });
  const r = await recomputeTargets({ prisma, userId: 1, localDate: TODAY });

  assert.equal(r.written, false);
  assert.equal(r.skipped, 'missing_inputs');
  assert.equal(prisma.calls.created.length, 0, 'nothing may be written without inputs');
});

test('a user-edited target is never overwritten by a recompute', async () => {
  // The number moving under the user is the exact failure this feature exists
  // to avoid. If they edited it, the edit wins and the response says so.
  const prisma = fakePrisma({
    goal: FULL_GOAL,
    weight: WEIGHT_READING,
    targets: [{ id: 7, source: 'user_edited' }],
  });
  const r = await recomputeTargets({ prisma, userId: 1, localDate: TODAY });

  assert.equal(r.written, false);
  assert.equal(r.skipped, 'user_edited');
  assert.equal(r.targetId, 7);
  assert.equal(prisma.calls.created.length, 0);
});

test('a formula target is replaced by a fresh formula target', async () => {
  const prisma = fakePrisma({
    goal: FULL_GOAL,
    weight: WEIGHT_READING,
    targets: [{ id: 3, source: 'formula' }],
  });
  const r = await recomputeTargets({ prisma, userId: 1, localDate: TODAY, rulesVersion: 'v1' });

  assert.equal(r.written, true);
  assert.equal(prisma.calls.created.length, 1);

  const row = prisma.calls.created[0];
  assert.equal(row.userId, 1);
  assert.equal(row.goal, 'recomp');
  assert.equal(row.source, 'formula');
  assert.equal(row.effectiveFrom, TODAY);
  assert.equal(row.rulesVersion, 'v1');
  // The stored inputs are what make "Why these numbers?" answerable months
  // later without re-deriving from a formula that may since have changed.
  assert.equal(row.inputs.weightKg, 70);
  assert.equal(row.inputs.heightCm, 175);
  assert.equal(row.kcal, r.targets.kcal);
  assert.deepEqual(row.micros, r.targets.micros);
});

test('a workout day is reflected in the water target that gets stored', async () => {
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING });
  const r = await recomputeTargets({
    prisma,
    userId: 1,
    localDate: TODAY,
    measured: { hasWorkoutToday: true, days: 20, dailyBurnKcal: 600 },
  });
  assert.equal(r.written, true);
  assert.equal(r.targets.waterMl, 2450 + 500);
  assert.equal(prisma.calls.created[0].inputs.waterAddend, 500);
});

// --- measured activity: coverage is not frequency --------------------------
//
// These exist because of a real bug. resolveActivity used to pass the day count
// into bandForMeasuredBurn's `avgSessionsPerWeek` slot, so a longer measurement
// window scored as more intense training. At a moderate 450 kcal/day every
// window of 14 days or more returned "very_active", raising the activity factor
// — and so the calorie target — on the strength of a calendar artefact.

test('a long window does not make a moderate burn look very active', () => {
  // 450 kcal/day sits in the "moderate, or very active with >= 5 sessions/week"
  // band. The tiebreaker has to be told the truth about frequency, which for
  // someone with no logged sessions is zero.
  for (const days of [14, 20, 30, 60, 90, 365]) {
    const r = resolveActivity({
      goal: { activity: 'sedentary' },
      measuredBurnKcal: 450,
      measuredDays: days,
      sessionsPerWeek: 0,
    });
    assert.equal(
      r.band,
      'moderate',
      `a ${days}-day window with no sessions must not read as very active`,
    );
  }
});

test('the 14-day threshold is about coverage, not window length', () => {
  // Genuinely few days of data in a long window still falls short, because the
  // evidence for the measured switch is days of readings.
  const few = resolveActivity({
    goal: { activity: 'sedentary' },
    measuredBurnKcal: 800,
    measuredDays: 9,
    sessionsPerWeek: 6,
  });
  assert.equal(few.isMeasured, false);
  assert.equal(few.activity, 'sedentary');

  // And enough days in a SHORT window clears it, because 14 days of readings is
  // 14 days of readings however they were captured.
  const enough = resolveActivity({
    goal: { activity: 'sedentary' },
    measuredBurnKcal: 800,
    measuredDays: MEASURED_ACTIVITY_THRESHOLD_DAYS,
    sessionsPerWeek: 2,
  });
  assert.equal(enough.isMeasured, true);
});

test('session frequency still decides the moderate/very-active tie', () => {
  // The tiebreaker has to keep working, or the fix above would have removed a
  // real signal along with the false one.
  const frequent = resolveActivity({
    goal: { activity: 'sedentary' },
    measuredBurnKcal: 450,
    measuredDays: 30,
    sessionsPerWeek: 5,
  });
  assert.equal(frequent.band, 'very_active');

  const occasional = resolveActivity({
    goal: { activity: 'sedentary' },
    measuredBurnKcal: 450,
    measuredDays: 30,
    sessionsPerWeek: 2,
  });
  assert.equal(occasional.band, 'moderate');
});

test('band boundaries do not depend on how long the user has been measured', () => {
  // Same routine, three different windows, one band. Anything else and the
  // target would drift upward on its own as the days accumulated.
  const bands = new Set(
    [14, 45, 90].map((days) =>
      resolveActivity({
        goal: { activity: 'light' },
        measuredBurnKcal: 450,
        measuredDays: days,
        sessionsPerWeek: 3,
      }).band,
    ),
  );
  assert.equal(bands.size, 1, 'the same routine must not change band with window length');
});

// --- the gatherer itself ---------------------------------------------------

test('coverage counts days with a reading, not the length of the window', async () => {
  // 28-day window, 20 days of readings. Coverage is 20, window is 28.
  // windowDays is passed explicitly because the default is the 14-day threshold,
  // and a test that assumed 28 would quietly measure the wrong window.
  const rows = Array.from({ length: 20 }, (_, i) => ({
    date: shift(TODAY, -(19 - i)),
    activeCalories: 400,
  }));
  const m = await gatherMeasuredActivity({
    prisma: fakePrisma({ activityRows: rows }),
    userId: 1,
    localDate: TODAY,
    windowDays: 28,
  });
  assert.equal(m.windowDays, 28);
  assert.equal(m.days, 20);
  assert.equal(m.dailyBurnKcal, 400);
});

test('frequency is normalised to a week regardless of window length', async () => {
  // 2 sessions in 28 days and 1 session in 14 days are the same routine, and
  // must be reported identically. The window length is what used to leak into
  // this number.
  const mk = (n, span) => ({
    activityRows: Array.from({ length: span }, (_, i) => ({
      date: shift(TODAY, -(span - 1 - i)),
      activeCalories: 450,
    })),
    sessions: Array.from({ length: n }, (_, i) => ({ localDate: shift(TODAY, -i) })),
  });

  const a = await gatherMeasuredActivity({
    prisma: fakePrisma(mk(2, 28)),
    userId: 1,
    localDate: TODAY,
    windowDays: 28,
  });
  const b = await gatherMeasuredActivity({
    prisma: fakePrisma(mk(1, 14)),
    userId: 1,
    localDate: TODAY,
    windowDays: 14,
  });
  assert.equal(a.sessionsPerWeek, 0.5);
  assert.equal(b.sessionsPerWeek, 0.5);
});

test('today burn comes from today, and today\'s session is read from the session', async () => {
  // Today's reading is deliberately much higher than the fortnight average, so
  // an implementation that averaged before checking "today" would answer wrong
  // and the water addend would be applied to the wrong day.
  const rows = Array.from({ length: 14 }, (_, i) => ({
    date: shift(TODAY, -(13 - i)),
    activeCalories: i === 13 ? 1200 : 300,
  }));
  const m = await gatherMeasuredActivity({
    prisma: fakePrisma({
      activityRows: rows,
      // A session yesterday and none today.
      sessions: [{ localDate: shift(TODAY, -1) }],
    }),
    userId: 1,
    localDate: TODAY,
  });
  assert.equal(m.todayBurnKcal, 1200);
  // (13 x 300 + 1200) / 14. Deliberately asserted exactly: the point is that
  // today's spike is included in the window average but does not become it.
  assert.equal(m.dailyBurnKcal, 5100 / 14);
  // Trained yesterday, not today: no addend.
  assert.equal(m.hasWorkoutToday, false);

  const trained = await gatherMeasuredActivity({
    prisma: fakePrisma({ activityRows: rows, sessions: [{ localDate: TODAY }] }),
    userId: 1,
    localDate: TODAY,
  });
  assert.equal(trained.hasWorkoutToday, true);
});

test('an empty window gathers as no data rather than as zero burn', async () => {
  const m = await gatherMeasuredActivity({ prisma: fakePrisma(), userId: 1, localDate: TODAY });
  assert.equal(m.days, 0);
  assert.equal(m.dailyBurnKcal, null);
  assert.equal(m.sessionsPerWeek, 0);
  assert.equal(m.hasWorkoutToday, false);
});

// --- recompute gathers when the caller does not pass measurements ----------

test('recompute gathers measurements when the caller passes none', async () => {
  // The controller never had a way to supply `measured`, so before this every
  // production recompute ran with days: 0 and could never reach the measured
  // switch. This test fails if the gather is ever removed or made opt-in again.
  const rows = Array.from({ length: 20 }, (_, i) => ({
    date: shift(TODAY, -(19 - i)),
    activeCalories: 800,
  }));
  const prisma = fakePrisma({
    goal: FULL_GOAL,
    weight: WEIGHT_READING,
    activityRows: rows,
  });

  const r = await recomputeTargets({ prisma, userId: 1, localDate: TODAY });
  assert.equal(r.written, true);
  assert.equal(r.activityIsMeasured, true);
  assert.equal(r.activityDetail.isMeasured, true);
  // 14, not 20: the default window is the 14-day threshold, so the extra six
  // days of fixture fall outside it. The number that matters is that coverage
  // was gathered at all — before this it was 0.
  assert.equal(r.activityDetail.daysObserved, MEASURED_ACTIVITY_THRESHOLD_DAYS);
  // And the band came from the gather, not the day count.
  assert.equal(r.activityDetail.band, 'very_active');
  assert.equal(r.inputs.activity, 'very_active');
  // The stored explanation records the resolved activity, so a later retune of
  // the formula cannot silently change which activity level produced this number.
  assert.equal(prisma.calls.created[0].inputs.activity, 'very_active');
});

// --- describeActivity: the read the app was faking with a write -------------

test('describeActivity writes nothing', async () => {
  // This is the whole reason it exists. The app used to POST the recompute
  // endpoint to fetch the explanation, so every visit to the targets screen
  // created a NutritionTarget row. The test asserts on the absence of writes
  // rather than on the return value, because that is the property at risk.
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING });
  const detail = await describeActivity({ prisma, userId: 1, localDate: TODAY });
  assert.ok(detail);
  assert.equal(prisma.calls.created.length, 0);
});

test('describeActivity reports the stated activity when there is no watch', async () => {
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING });
  const detail = await describeActivity({ prisma, userId: 1, localDate: TODAY });
  assert.equal(detail.isMeasured, false);
  assert.equal(detail.usedStatedActivity, 'moderate');
  assert.equal(detail.daysObserved, 0);
  assert.equal(detail.ignoredBecause, null);
});

test('describeActivity explains a user_edited target, which recompute cannot', async () => {
  // The case that motivated the split. recomputeTargets returns early for a
  // hand-edited target and never reaches the detail block, so this user got no
  // explanation at all - backwards, because they are the one who least knows
  // where the number came from.
  const prisma = fakePrisma({
    goal: FULL_GOAL,
    weight: WEIGHT_READING,
    targets: [{ id: 1, source: 'user_edited', kcal: 1800 }],
  });

  const recompute = await recomputeTargets({ prisma, userId: 1, localDate: TODAY });
  assert.equal(recompute.written, false);
  assert.equal(recompute.skipped, 'user_edited');
  assert.equal(recompute.activityDetail, undefined, 'recompute cannot explain this case');

  // The read can, and does not touch the target.
  const detail = await describeActivity({ prisma, userId: 1, localDate: TODAY });
  assert.equal(detail.usedStatedActivity, 'moderate');
  assert.equal(prisma.calls.created.length, 0);
});

test('describeActivity answers with no goal on file at all', async () => {
  // Not a 404 and not a null. The activity half is still a true statement, and
  // the wizard shows this screen before any goal exists.
  const prisma = fakePrisma({ goal: null });
  const detail = await describeActivity({ prisma, userId: 1, localDate: TODAY });
  assert.equal(detail.isMeasured, false);
  assert.equal(detail.usedStatedActivity, null);
  assert.equal(detail.daysObserved, 0);
});

test('describeActivity reports the measured band once coverage clears', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    date: shift(TODAY, -(19 - i)),
    activeCalories: 800,
  }));
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING, activityRows: rows });
  const detail = await describeActivity({ prisma, userId: 1, localDate: TODAY });
  assert.equal(detail.isMeasured, true);
  assert.equal(detail.band, 'very_active');
  assert.equal(detail.daysObserved, MEASURED_ACTIVITY_THRESHOLD_DAYS);
});

test('describeActivity names a near-silent watch rather than calling it sedentary', async () => {
  // The distinction the payload exists to preserve: a device that was not worn
  // is not a sedentary life, and the two need different words on screen.
  const rows = Array.from({ length: 20 }, (_, i) => ({
    date: shift(TODAY, -(19 - i)),
    activeCalories: 5,
  }));
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING, activityRows: rows });
  const detail = await describeActivity({ prisma, userId: 1, localDate: TODAY });
  assert.equal(detail.isMeasured, false);
  assert.equal(detail.ignoredBecause, 'measured_burn_below_floor');
  assert.equal(detail.usedStatedActivity, 'moderate');
});

test('describeActivity and recompute agree when the app is fully set up', async () => {
  // Two code paths producing the same explanation would eventually drift, and
  // the drift would show up as the targets screen contradicting itself
  // depending on which call it happened to use.
  const rows = Array.from({ length: 20 }, (_, i) => ({
    date: shift(TODAY, -(19 - i)),
    activeCalories: 800,
  }));
  const sessions = [{ localDate: shift(TODAY, -2) }, { localDate: shift(TODAY, -9) }];
  const prisma = fakePrisma({
    goal: FULL_GOAL,
    weight: WEIGHT_READING,
    activityRows: rows,
    sessions,
  });

  const written = await recomputeTargets({ prisma, userId: 1, localDate: TODAY });
  const read = await describeActivity({ prisma, userId: 1, localDate: TODAY });
  assert.deepEqual(read, written.activityDetail);
});

test('describeActivity honours a caller-supplied measurement without querying', async () => {
  // Lets the test double drive the band without 20 rows of fixture, and mirrors
  // how a caller that already has the data may pass it in.
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING });
  const detail = await describeActivity({
    prisma,
    userId: 1,
    localDate: TODAY,
    measured: { days: 20, dailyBurnKcal: 800, sessionsPerWeek: 2, sessionsInWindow: 4, windowDays: 28 },
  });
  assert.equal(detail.isMeasured, true);
  assert.equal(detail.windowDays, 28);
  assert.equal(detail.sessionsPerWeek, 2);
});

test('recompute reports why measured activity was ignored', async () => {
  // No data at all: the screen needs "still gathering" rather than a silent
  // fallback that looks identical to "we used what you told us".
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING });
  const r = await recomputeTargets({ prisma, userId: 1, localDate: TODAY });
  assert.equal(r.activityIsMeasured, false);
  assert.equal(r.activityDetail.usedStatedActivity, 'moderate');
  assert.equal(r.activityDetail.daysObserved, 0);

  // A watch that recorded almost nothing is a different case, and is named.
  const broken = fakePrisma({
    goal: FULL_GOAL,
    weight: WEIGHT_READING,
    activityRows: Array.from({ length: 20 }, (_, i) => ({
      date: shift(TODAY, -(19 - i)),
      activeCalories: 5,
    })),
  });
  const r2 = await recomputeTargets({ prisma: broken, userId: 1, localDate: TODAY });
  assert.equal(r2.activityIsMeasured, false);
  assert.equal(r2.activityDetail.ignoredBecause, 'measured_burn_below_floor');
  assert.equal(r2.activityDetail.usedStatedActivity, 'moderate');
});

test('a partial measured object does not crash the detail block', async () => {
  // Callers and tests pass measured objects that predate activityDetail, and the
  // detail block must report "unknown" for fields it was not given rather than
  // throwing on a missing number.
  const prisma = fakePrisma({ goal: FULL_GOAL, weight: WEIGHT_READING });
  const r = await recomputeTargets({
    prisma,
    userId: 1,
    localDate: TODAY,
    measured: { hasWorkoutToday: true, days: 20, dailyBurnKcal: 600 },
  });
  assert.equal(r.written, true);
  assert.equal(r.activityDetail.sessionsPerWeek, null);
  assert.equal(r.activityDetail.windowDays, null);
  assert.equal(r.targets.waterMl, 2450 + 500);
});
