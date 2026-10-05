import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePlan } from '../services/ledger/planGenerator.js';
import { MAX_ACTIVE_PLAN_ITEMS, TARGET_MAX_ITEMS } from '../services/ledger/planGenerator.js';

const TARGETS = {
  kcal: 2500,
  proteinG: 133,
  carbsG: 300,
  fatG: 78,
  fibreG: 35,
  waterMl: 2950,
  micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
};

// The single most important test in the plan. If this fails, the feature has
// crossed from "wellness software" into "medical device" territory and must
// not ship in that state.
test('the generator cannot emit a doctor-sourced item, even for a user full of medical data', () => {
  const r = generatePlan({
    goals: ['doctor_plan'],
    targets: TARGETS,
    measuredActivity: 'light',
    hasDoctorItems: true,
  });

  for (const item of r.items) {
    assert.notEqual(
      item.origin,
      'doctor',
      'generatePlan produced a doctor-origin item: the medical line has been breached',
    );
  }

  // Nothing condition-shaped either. A title that reads like a treatment
  // instruction is the failure mode the origin enum alone would not catch.
  const forbidden = /anemia|anaemia|thyroid|diabet|blood\s*pressure|insulin|dosage|dose|mg\s*daily|treatment|prescrib/i;
  for (const item of r.items) {
    assert.ok(!forbidden.test(item.title), `condition-shaped title leaked: "${item.title}"`);
  }

  // "I have a doctor's plan" is reported, not reproduced.
  assert.equal(r.hasDoctorItems, true);
});

test('no goal type produces a doctor item', () => {
  for (const goals of [
    ['build_muscle'],
    ['lose_fat'],
    ['recomp'],
    ['endurance'],
    ['general_health'],
    ['doctor_plan'],
    // A set, and specifically one containing doctor_plan: the medical line is a
    // property of the PLAN GENERATOR, so it has to hold when the goal set carries
    // a clinical objective alongside an ordinary one.
    ['doctor_plan', 'build_muscle'],
    ['build_muscle', 'lose_fat', 'general_health'],
  ]) {
    const r = generatePlan({ goals, targets: TARGETS, measuredActivity: 'moderate' });
    const label = goals.join('+');
    assert.ok(r.items.length > 0, `${label} produced an empty plan`);
    assert.ok(
      r.items.every((i) => i.origin === 'suggested'),
      `${label} produced a non-suggested item`,
    );
  }
});

test('a plan stays inside the size band', () => {
  // A 20-item plan turns every day red, which kills the feature faster than
  // any scoring bug.
  for (const measured of [null, 'sedentary', 'light', 'moderate', 'very_active']) {
    const r = generatePlan({ goals: ['recomp'], targets: TARGETS, measuredActivity: measured });
    assert.ok(r.items.length <= TARGET_MAX_ITEMS, `${measured}: ${r.items.length} items exceeds the band`);
    assert.ok(r.items.length >= 4, `${measured}: ${r.items.length} items is too thin to be a plan`);
    assert.ok(r.items.length <= MAX_ACTIVE_PLAN_ITEMS);
  }
});

test('the doc\'s worked example is reproduced: protein, 4 sessions, sleep, water', () => {
  // phool-gobhi-health-ledger-plan-20260927.html §8 for the 70 kg recomposing
  // man: "Plan: protein target, 4× strength sessions, sleep 7 h, water 3.2 L".
  const r = generatePlan({
    goals: ['recomp'],
    targets: TARGETS,
    measuredActivity: 'moderate', // 4 logged workouts a week
  });

  const kinds = r.items.map((i) => i.kind);
  assert.ok(kinds.includes('nutrition'));
  assert.ok(kinds.includes('workout'));
  assert.ok(kinds.includes('rest'));
  assert.ok(kinds.includes('habit'));

  const protein = r.items.find((i) => i.nutrientKey === 'proteinG');
  assert.equal(protein.targetValue, 133);

  const workout = r.items.find((i) => i.kind === 'workout');
  assert.equal(workout.schedule.split(',').length, 4, 'measured-moderate must mean 4 sessions');
  assert.match(workout.title, /strength/i);

  // Sleep and water are habits, and water tracks the target it was given.
  const water = r.items.find((i) => /water/i.test(i.title));
  assert.ok(water, 'expected a water habit');
  assert.match(water.title, /3\.0 L/); // 2950 ml rounds to 3.0 L

  const sleep = r.items.find((i) => /sleep/i.test(i.title));
  assert.equal(sleep.schedule, 'daily');
});

test('a rest day is always scheduled, on a day the plan asks for no workout', () => {
  // Without this, the generator schedules its own rest day and the scorer
  // marks it as a missed workout — the engine punishing its own plan.
  for (const measured of [null, 'sedentary', 'light', 'moderate', 'very_active']) {
    const r = generatePlan({ goals: ['general_health'], targets: TARGETS, measuredActivity: measured });
    const rest = r.items.find((i) => i.kind === 'rest');
    assert.ok(rest, `${measured}: no rest day`);

    const workoutDays = new Set(
      (r.items.find((i) => i.kind === 'workout')?.schedule ?? '').split(',').map(Number),
    );
    const restDay = Number(rest.schedule);
    assert.ok(
      !workoutDays.has(restDay),
      `${measured}: rest day ${restDay} collides with a workout day`,
    );
  }
});

test('iron foods respect the diet pattern', () => {
  // A Jain user being told to eat chicken is a correctness failure that would
  // ship silently, because the item title is just a string and nothing else
  // in the request path validates it.
  for (const [diet, banned] of [
    ['vegan', /chicken|egg|curd|whey|paneer|dal makhani/i],
    ['jain', /chicken|egg|onion|garlic/i],
    ['non_veg', /^$/],
  ]) {
    const r = generatePlan({
      goals: ['general_health'],
      diet,
      targets: TARGETS,
      measuredActivity: null,
    });
    const iron = r.items.find((i) => /iron/i.test(i.title));
    assert.ok(iron, `${diet}: no iron item`);
    assert.ok(!banned.test(iron.title), `${diet}: banned food in "${iron.title}"`);
  }
});

test('the workout split matches the frequency it claims', () => {
  // Regression: the split table used to be a flat array indexed by
  // frequency, so a 2-day prescription scheduled 3 days and a 3-day one
  // scheduled 4. Each row must contain exactly as many days as its key.
  const expected = {
    sedentary: 2,
    light: 3,
    moderate: 4,
    very_active: 5,
  };
  for (const [measured, days] of Object.entries(expected)) {
    const r = generatePlan({ goals: ['recomp'], targets: TARGETS, measuredActivity: measured });
    const workout = r.items.find((i) => i.kind === 'workout');
    const actual = workout.schedule.split(',');
    assert.equal(actual.length, days, `${measured}: scheduled ${actual.length} days, expected ${days}`);
    // No duplicate days, and none in 1..7 outside the range.
    assert.equal(new Set(actual).size, actual.length, `${measured}: duplicate days in ${workout.schedule}`);
    for (const d of actual) {
      const n = Number(d);
      assert.ok(n >= 1 && n <= 7, `${measured}: day ${n} out of range`);
    }
  }
});

test('a user-supplied supplement is never added by the generator', () => {
  // The doc: "No supplements in the plan unless he adds one". The generator
  // has no supplement vocabulary at all, and this asserts it.
  const r = generatePlan({ goals: ['build_muscle'], targets: TARGETS, measuredActivity: 'very_active' });
  const supplementish = /whey|creatine|multivitamin|supplement|protein powder|bcAA/i;
  for (const item of r.items) {
    assert.ok(!supplementish.test(item.title), `generator proposed a supplement: "${item.title}"`);
  }
});
