import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ageFromDob,
  getSetupState,
  saveIntake,
  checkTargetPace,
  validateIntake,
} from '../services/ledger/ledgerIntakeService.js';

const TODAY = '2026-09-28';

// The double records writes instead of performing them, so these tests can assert
// WHERE a value went. That is the whole point of this file: the single most
// important behaviour is that a weight does not land in HealthGoal.
function fakePrisma({ goal = null, profile = null, weight = null, todayWeight = null } = {}) {
  const calls = { goalCreate: [], goalUpdate: [], entryCreate: [], entryUpdate: [] };
  return {
    calls,
    healthGoal: {
      findUnique: async () => goal,
      create: async ({ data }) => {
        calls.goalCreate.push(data);
        return { userId: 1, ...data };
      },
      update: async ({ data }) => {
        calls.goalUpdate.push(data);
        return { userId: 1, ...goal, ...data };
      },
    },
    personalisationProfile: {
      findUnique: async () => profile,
    },
    biometricEntry: {
      findFirst: async () => weight,
      findUnique: async () => todayWeight,
      create: async ({ data }) => {
        calls.entryCreate.push(data);
        return { id: 1, ...data };
      },
      update: async ({ data }) => {
        calls.entryUpdate.push(data);
        return { id: 1, ...data };
      },
    },
  };
}

// --- the weight rule --------------------------------------------------------

test('a weight given at intake becomes a BiometricEntry, not a HealthGoal field', async () => {
  const prisma = fakePrisma();
  const r = await saveIntake({
    prisma,
    userId: 1,
    localDate: TODAY,
    input: { goal: 'recomp', weightKg: 72.5, age: 29, sex: 'male', heightCm: 175, activity: 'moderate' },
  });

  assert.equal(r.written, true);
  assert.equal(r.weightWritten, true);

  // The time series gets it...
  assert.equal(prisma.calls.entryCreate.length, 1);
  assert.equal(prisma.calls.entryCreate[0].metric, 'weight');
  assert.equal(prisma.calls.entryCreate[0].value, 72.5);
  assert.equal(prisma.calls.entryCreate[0].localDate, TODAY);

  // ...and the snapshot table never sees a weight. HealthGoal has no weight
  // column at all, and adding one is the bug this test exists to prevent: a
  // second copy goes stale the moment weight changes, and the stored target
  // would then describe a body that no longer exists.
  assert.equal('weightKg' in prisma.calls.goalCreate[0], false);
});

test('re-entering the same weight twice in a day corrects the reading', async () => {
  const prisma = fakePrisma({ todayWeight: { id: 'existing' } });
  const r = await saveIntake({
    prisma,
    userId: 1,
    localDate: TODAY,
    input: { goal: 'recomp', weightKg: 70.4 },
  });

  assert.equal(r.written, true);
  assert.equal(prisma.calls.entryCreate.length, 0, 'must not create a second row for today');
  assert.equal(prisma.calls.entryUpdate.length, 1);
  assert.equal(prisma.calls.entryUpdate[0].value, 70.4);
});

test('a repeated intake save does not duplicate the weight history', async () => {
  // Two saves on different days, same weight. The second must not assume the
  // first is still today's reading.
  const day1 = fakePrisma();
  await saveIntake({ prisma: day1, userId: 1, localDate: '2026-09-27', input: { goal: 'recomp', weightKg: 72 } });
  assert.equal(day1.calls.entryCreate[0].localDate, '2026-09-27');

  // The goal from the first save now exists, so the second send is an update
  // rather than a create — and its weight belongs to a new day, not to the
  // 27th. "Today's reading" is relative to the day being written.
  const day2 = fakePrisma({ goal: { userId: 1, goal: 'recomp' }, todayWeight: null });
  const r2 = await saveIntake({ prisma: day2, userId: 1, localDate: TODAY, input: { weightKg: 72 } });
  assert.equal(r2.written, true);
  assert.equal(day2.calls.entryCreate.length, 1);
  assert.equal(day2.calls.entryCreate[0].localDate, TODAY, 'a new day is a new reading');
});

test('an intake save without a weight leaves the time series alone', async () => {
  const prisma = fakePrisma();
  const r = await saveIntake({ prisma, userId: 1, localDate: TODAY, input: { goal: 'build_muscle', age: 30 } });
  assert.equal(r.written, true);
  assert.equal(r.weightWritten, false);
  assert.equal(prisma.calls.entryCreate.length, 0);
  assert.equal(prisma.calls.entryUpdate.length, 0);
});

// --- partial saves ----------------------------------------------------------

test('a save touches only the fields the user actually answered', async () => {
  const prisma = fakePrisma({
    goal: { userId: 1, goal: 'recomp', age: 29, sex: 'male', heightCm: 175, activity: 'moderate' },
  });
  await saveIntake({ prisma, userId: 1, localDate: TODAY, input: { age: 30 } });

  assert.deepEqual(Object.keys(prisma.calls.goalUpdate[0]), ['age']);
  // The values the user set earlier are still there, because the screen
  // pre-fills from the server and would otherwise have echoed them back as
  // nulls on every save.
  assert.equal(prisma.calls.goalUpdate[0].age, 30);
});

test('saving a goal for the first time requires a goal', async () => {
  const prisma = fakePrisma();
  const r = await saveIntake({ prisma, userId: 1, localDate: TODAY, input: { age: 30, heightCm: 175 } });
  assert.equal(r.written, false);
  assert.equal(r.skipped, 'invalid');
  assert.match(r.errors.goal, /working towards/);
  assert.equal(prisma.calls.goalCreate.length, 0);
});

test('an existing user can update without resending the goal', async () => {
  const prisma = fakePrisma({ goal: { userId: 1, goal: 'lose_fat' } });
  const r = await saveIntake({ prisma, userId: 1, localDate: TODAY, input: { activity: 'light' } });
  assert.equal(r.written, true);
  assert.equal(prisma.calls.goalUpdate[0].activity, 'light');
});

// --- validation -------------------------------------------------------------

test('implausible values are refused with a sentence the form can show', () => {
  assert.ok(validateIntake({ age: 8 }).age);
  // Health+ is 18+: a typed 13–17 must not slip past the consent gate's line.
  assert.ok(validateIntake({ age: 13 }).age);
  assert.ok(validateIntake({ age: 17 }).age);
  assert.ok(validateIntake({ age: 130 }).age);
  assert.ok(validateIntake({ heightCm: 20 }).heightCm);
  assert.ok(validateIntake({ heightCm: 400 }).heightCm);
  assert.ok(validateIntake({ weightKg: 10 }).weightKg);
  assert.ok(validateIntake({ goal: 'get_ripped' }).goal);
  assert.ok(validateIntake({ sex: 'x' }).sex);
  assert.ok(validateIntake({ activity: 'superhuman' }).activity);
  assert.ok(validateIntake({ diet: 'carnivore' }).diet);
  // 2026-02-31 is not a date.
  assert.ok(validateIntake({ targetDate: '2026-02-31' }).targetDate);
  assert.ok(validateIntake({ targetDate: '28/09/2026' }).targetDate);

  // Plausible values pass, including the boundaries.
  assert.deepEqual(validateIntake({ age: 18, heightCm: 90, weightKg: 25, sex: 'other', activity: 'sedentary', diet: 'vegan' }), {});
  assert.deepEqual(validateIntake({ age: 100, heightCm: 250, weightKg: 400 }), {});
});

test('an invalid answer writes nothing at all', async () => {
  const prisma = fakePrisma();
  const r = await saveIntake({ prisma, userId: 1, localDate: TODAY, input: { goal: 'recomp', age: 8, weightKg: 70 } });
  assert.equal(r.written, false);
  assert.equal(r.skipped, 'invalid');
  // Including the weight: a batch that half-applies leaves the user with a
  // reading they did not intend and no goal to explain it.
  assert.equal(prisma.calls.entryCreate.length, 0);
  assert.equal(prisma.calls.goalCreate.length, 0);
});

test('a long allergen list is refused rather than truncated', () => {
  const many = Array.from({ length: 31 }, (_, i) => `allergen-${i}`);
  assert.ok(validateIntake({ allergies: many }).allergies);
  assert.ok(validateIntake({ allergies: ['x'.repeat(61)] }).allergies);
  assert.deepEqual(validateIntake({ allergies: ['peanut', 'shellfish'] }), {});
});

// --- the safe-pace rule -----------------------------------------------------

test('a target faster than 0.75 kg/week is refused with an honest date', () => {
  // 80 kg wanting 70 kg in 4 weeks is 2.5 kg/week. Way past the cap.
  const r = checkTargetPace({
    startWeightKg: 80,
    targetWeightKg: 70,
    startDate: '2026-09-28',
    targetDate: '2026-10-26',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TARGET_TOO_AGGRESSIVE');
  assert.equal(r.limitedBy, 'max_weekly_loss_0.75kg');
  assert.equal(r.maxWeeklyLossKg, 0.75);
  // 10 kg at 0.75/week is 13.33 weeks, rounded up to 14 — a partial week is not
  // something a date can express, so the service promises the next whole one.
  assert.equal(r.weeksNeeded, 14);
  assert.equal(r.earliestDate, '2027-01-04');
  assert.match(r.error, /0\.75 kg\/week/);
  // And the refusal names what was asked for, so the copy can be specific.
  assert.equal(r.requiredWeeklyLossKg, 2.5);
});

test('a small person is held to the tighter of the two limits', () => {
  // 1% of 50 kg is 0.5 kg/week, tighter than the flat 0.75. A naive
  // implementation that only knew 0.75 would let a 50 kg user lose 0.7 kg/week.
  // 50 -> 48 kg over 4 weeks is 0.5 exactly, so 3 weeks is used to be clearly
  // over the line rather than sitting on the boundary.
  const r = checkTargetPace({
    startWeightKg: 50,
    targetWeightKg: 48,
    startDate: '2026-09-28',
    targetDate: '2026-10-19',
  });
  assert.equal(r.ok, false);
  assert.equal(r.limitedBy, 'max_weekly_loss_pct_body_weight');
  assert.equal(r.maxWeeklyLossKg, 0.5);
  // 2 kg at 0.5/week is 4 weeks.
  assert.equal(r.weeksNeeded, 4);
  assert.equal(r.earliestDate, '2026-10-26');
});

test('a larger person is held to 0.75 kg/week, not 1%', () => {
  // 1% of 120 kg is 1.2 kg/week, so the flat cap is the binding one.
  const r = checkTargetPace({
    startWeightKg: 120,
    targetWeightKg: 112,
    startDate: '2026-09-28',
    targetDate: '2026-11-23',
  });
  assert.equal(r.ok, false);
  assert.equal(r.limitedBy, 'max_weekly_loss_0.75kg');
  assert.equal(r.maxWeeklyLossKg, 0.75);
});

test('an achievable target is allowed', () => {
  // 80 -> 76 kg over 8 weeks is 0.5 kg/week. Fine.
  const r = checkTargetPace({
    startWeightKg: 80,
    targetWeightKg: 76,
    startDate: '2026-09-28',
    targetDate: '2026-11-23',
  });
  assert.equal(r.ok, true);
});

test('only a requested loss is pace-checked', () => {
  // Gaining has no deficit to cap, and the plan does not promise a ceiling on
  // it. Refusing a bulk would be the service inventing a clinical limit.
  const gain = checkTargetPace({
    startWeightKg: 60,
    targetWeightKg: 68,
    startDate: '2026-09-28',
    targetDate: '2026-10-12',
  });
  assert.equal(gain.ok, true);

  // Maintaining is trivially fine.
  const same = checkTargetPace({
    startWeightKg: 60,
    targetWeightKg: 60,
    startDate: '2026-09-28',
    targetDate: '2026-10-12',
  });
  assert.equal(same.ok, true);
});

test('a missing weight or date skips the check instead of guessing', () => {
  assert.equal(checkTargetPace({ startWeightKg: null, targetWeightKg: 70, startDate: '2026-09-28', targetDate: '2026-10-01' }).ok, true);
  assert.equal(checkTargetPace({ startWeightKg: 80, targetWeightKg: 70, startDate: '2026-09-28', targetDate: null }).ok, true);
});

test('a target date that has already passed is refused as a date problem', async () => {
  // checkTargetPace alone returns ok for a non-positive interval, because a
  // negative span has no meaningful pace and reporting "0.3 kg/week" for it
  // would be nonsense. The refusal therefore has to happen in validation, where
  // the user can be told to pick a later date.
  const prisma = fakePrisma();
  const r = await saveIntake({
    prisma,
    userId: 1,
    localDate: TODAY,
    input: { goal: 'lose_fat', weightKg: 80, targetWeightKg: 70, targetDate: '2026-01-01' },
  });
  assert.equal(r.written, false);
  assert.equal(r.skipped, 'invalid');
  assert.match(r.errors.targetDate, /has not passed/);
  assert.equal(prisma.calls.goalCreate.length, 0);
});

test('a target date in the future is accepted where a measurement date would not be', () => {
  // The two date fields have opposite rules, and conflating them either
  // rejects every real goal ("by December") or accepts a future weight reading
  // ("I weighed 70 kg on a day that has not happened").
  assert.ok(validateIntake({ targetDate: '2026-01-01' }).targetDate, 'a past target is refused');
  assert.deepEqual(validateIntake({ targetDate: '2027-06-01' }), {}, 'a future target is fine');
  // startDate may be today or later, same reasoning.
  assert.deepEqual(validateIntake({ startDate: '2027-01-01' }), {});
});

test('a rejected target writes nothing', async () => {
  const prisma = fakePrisma();
  const r = await saveIntake({
    prisma,
    userId: 1,
    localDate: TODAY,
    input: {
      goal: 'lose_fat',
      weightKg: 80,
      targetWeightKg: 70,
      targetDate: '2026-10-26',
    },
  });
  assert.equal(r.written, false);
  assert.equal(r.skipped, 'target_too_aggressive');
  // Nothing partial: no goal row carrying the impossible pair, and no orphaned
  // weight reading from a save that was refused.
  assert.equal(prisma.calls.goalCreate.length, 0);
  assert.equal(prisma.calls.entryCreate.length, 0);
});

// --- the setup read ---------------------------------------------------------

test('the setup state asks only for what is missing', async () => {
  // No goal at all: everything is missing, which is what a first-run user sees.
  // The field names are the engine's own vocabulary (weight/height, not
  // weightKg/heightCm) so the screen's keys cannot drift from the engine.
  const fresh = await getSetupState({ prisma: fakePrisma(), userId: 1, localDate: TODAY });
  assert.equal(fresh.hasGoal, false);
  assert.equal(fresh.goal, null);
  for (const field of ['goal', 'weight', 'height', 'age', 'sex', 'activity']) {
    assert.ok(fresh.missing.includes(field), `a first-run user is missing ${field}`);
  }
  // Reasons are plain sentences, for the screen to show.
  assert.ok(typeof fresh.reasons.goal === 'string' && fresh.reasons.goal.length > 0);
  assert.ok(typeof fresh.reasons.weight === 'string' && fresh.reasons.weight.length > 0);

  // A complete user: nothing missing, and their values are prefilled.
  const done = await getSetupState({
    prisma: fakePrisma({
      goal: { userId: 1, goal: 'recomp', age: 29, sex: 'male', heightCm: 175, activity: 'moderate', diet: 'veg', allergies: [] },
      weight: { metric: 'weight', value: 72, unit: 'kg', localDate: '2026-09-27' },
    }),
    userId: 1,
    localDate: TODAY,
  });
  assert.equal(done.hasGoal, true);
  assert.equal(done.goal, 'recomp');
  assert.deepEqual(done.missing, []);
  assert.deepEqual(done.reasons, {});
  assert.equal(done.prefill.weightKg, 72);
  assert.equal(done.prefill.age, 29);
  assert.equal(done.prefill.heightCm, 175);
});

test('a user with a goal is asked only about the gaps', async () => {
  // Has a goal and an age, nothing else. The list must be the remaining three,
  // not the full six and not the single short-circuit value.
  const r = await getSetupState({
    prisma: fakePrisma({
      goal: { userId: 1, goal: 'lose_fat', age: 31 },
      weight: null,
    }),
    userId: 1,
    localDate: TODAY,
  });
  assert.deepEqual(r.missing.sort(), ['activity', 'height', 'sex', 'weight']);
  // The one they already answered is prefilled, not asked for.
  assert.equal(r.prefill.age, 31);
  assert.equal(r.prefill.goal, 'lose_fat');
});

test('the setup state falls back to the legacy profile for height only', async () => {
  // A user who set up the older health-metrics feature has a height on file and
  // should not be asked for it again.
  const r = await getSetupState({
    prisma: fakePrisma({
      profile: { heightCm: 180 },
      goal: { userId: 1, goal: 'recomp', age: 29, sex: 'male' },
      weight: { metric: 'weight', value: 70, unit: 'kg', localDate: TODAY },
    }),
    userId: 1,
    localDate: TODAY,
  });
  assert.equal(r.prefill.heightCm, 180);
  // HealthGoal's own snapshot wins when both have it.
  const both = await getSetupState({
    prisma: fakePrisma({
      profile: { heightCm: 180 },
      goal: { userId: 1, goal: 'recomp', age: 29, sex: 'male', heightCm: 175 },
      weight: { metric: 'weight', value: 70, unit: 'kg', localDate: TODAY },
    }),
    userId: 1,
    localDate: TODAY,
  });
  assert.equal(both.prefill.heightCm, 175);
});

test('the setup state does not read age or sex from a table that has none', async () => {
  // PersonalisationProfile has no age or sex columns. If this ever queries them
  // it will throw, so the assertion is on the shape of the result rather than
  // on a mock expectation.
  const r = await getSetupState({ prisma: fakePrisma(), userId: 1, localDate: TODAY });
  assert.equal(r.prefill.age, null);
  assert.equal(r.prefill.sex, null);
  assert.ok(r.options.goals.length > 0);
  assert.ok(r.options.goals.every((g) => typeof g.label === 'string' && g.label.length > 0));
  assert.equal(r.limits.maxWeeklyLossKg, 0.75);
  assert.equal(r.limits.maxWeeklyLossPct, 0.01);
});

test('the setup state reports a Decimal target weight as a number', async () => {
  // Prisma returns Decimal for targetWeightKg. Serialising that raw would either
  // throw or become a string, and a text field cannot compare against a number.
  const r = await getSetupState({
    prisma: fakePrisma({
      goal: { userId: 1, goal: 'lose_fat', age: 29, sex: 'male', heightCm: 175, targetWeightKg: { toString: () => '70.5' } },
      weight: { metric: 'weight', value: 80, unit: 'kg', localDate: TODAY },
    }),
    userId: 1,
    localDate: TODAY,
  });
  assert.equal(r.prefill.targetWeightKg, 70.5);
  assert.equal(typeof r.prefill.targetWeightKg, 'number');
});

// --- prefill from the auth profile (onboarding audit P0-4) --------------------

test('age and sex prefill from the signup DOB and gender when no goal exists', async () => {
  const r = await getSetupState({
    prisma: fakePrisma(),
    userId: 1,
    localDate: TODAY,
    fetchProfile: async () => ({ dateOfBirth: '1995-10-15T00:00:00.000Z', gender: 'female' }),
  });
  // 2026-09-28 is before the 15 Oct birthday, so 30, not 31.
  assert.equal(r.prefill.age, 30);
  assert.equal(r.prefill.sex, 'female');
});

test('a saved HealthGoal snapshot wins over the auth profile', async () => {
  const r = await getSetupState({
    prisma: fakePrisma({ goal: { userId: 1, goal: 'recomp', age: 29, sex: 'male' } }),
    userId: 1,
    localDate: TODAY,
    fetchProfile: async () => ({ dateOfBirth: '1980-01-01', gender: 'female' }),
  });
  assert.equal(r.prefill.age, 29);
  assert.equal(r.prefill.sex, 'male');
});

test('prefill never offers an under-18 age, an unmapped gender, or survives a failed fetch', async () => {
  const young = await getSetupState({
    prisma: fakePrisma(),
    userId: 1,
    localDate: TODAY,
    fetchProfile: async () => ({ dateOfBirth: '2010-01-01', gender: 'prefer_not_to_say' }),
  });
  assert.equal(young.prefill.age, null);
  assert.equal(young.prefill.sex, null);

  const failed = await getSetupState({
    prisma: fakePrisma(),
    userId: 1,
    localDate: TODAY,
    fetchProfile: async () => { throw new Error('auth down'); },
  });
  assert.equal(failed.prefill.age, null);
});

test('ageFromDob counts whole years and handles the birthday itself', () => {
  assert.equal(ageFromDob('2000-09-28', '2026-09-28'), 26);
  assert.equal(ageFromDob('2000-09-29', '2026-09-28'), 25);
  assert.equal(ageFromDob(null, '2026-09-28'), null);
  assert.equal(ageFromDob('not a date', '2026-09-28'), null);
});
