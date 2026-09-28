import test from 'node:test';
import assert from 'node:assert/strict';

import {
  latestWeightKg,
  resolveInputs,
  recomputeTargets,
  resolveActivity,
  MISSING_REASONS,
} from '../services/ledger/targetService.js';
import { MEASURED_ACTIVITY_THRESHOLD_DAYS } from '../services/ledger/constants.js';

const TODAY = '2026-09-28';

// A hand-rolled Prisma double rather than a mocking library: the queries this
// service makes are three findUnique/findFirst calls, and a stub that returns
// canned rows keeps the test honest about what the service actually asked for.
function fakePrisma({
  goal = null,
  profile = null,
  weight = null,
  targets = [],
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
