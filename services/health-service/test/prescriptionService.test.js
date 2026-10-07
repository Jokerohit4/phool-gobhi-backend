// The adjustable plan behind the app's "Your plan" screen.
//
// Four things matter here and none of them are obvious from reading the code:
//
//   1. The client may NOT answer. It sends four integers; macros, water,
//      micros and the workout week are derived from NutritionTarget. A protein
//      target the client could supply is one that disagrees with the targets
//      screen for the same person on the same day.
//   2. Preview never writes. A drag may be dragged a hundred times, and every
//      one of them is a question rather than a commitment.
//   3. Bounds are rules and they travel with the response. A kcal floor that
//      differs from the slider is a refusal the user can reproduce by
//      dragging.
//   4. A read clamps and says so (`adjustedBy`); a write refuses (422). A GET
//      that answered 422 would leave the screen with no plan and nothing to
//      fix, the moment the person's weight moved the floor.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boundsFor,
  buildWorkout,
  deriveStepsPerDay,
  getPlan,
  previewPlan,
  savePlan,
} from '../services/ledger/prescriptionService.js';

const TARGET = {
  userId: 7,
  goals: ['lose_fat'],
  effectiveFrom: '2026-10-01',
  kcal: 2200,
  proteinG: 130,
  carbsG: 240,
  fatG: 70,
  fibreG: 30,
  waterMl: 3000,
  micros: { ironMg: 18, magnesiumMg: 340 },
  inputs: {
    weightKg: 72,
    heightCm: 175,
    age: 28,
    sex: 'male',
    activity: 'moderate',
    bmrKcal: 1674,
    maintenanceKcal: 2620,
    fatFraction: 0.28,
    goals: ['lose_fat'],
  },
  rulesVersion: 'v1',
};

function fakePrisma({ target = TARGET, weekly = null, saved = null } = {}) {
  const writes = [];
  return {
    writes,
    nutritionTarget: { findFirst: async () => target },
    weeklyGoal: {
      findUnique: async () => weekly,
      upsert: async (args) => writes.push({ model: 'weeklyGoal', args }),
    },
    prescription: {
      findUnique: async () => saved,
      upsert: async (args) => writes.push({ model: 'prescription', args }),
    },
  };
}

// ---- The pure rules -------------------------------------------------------

test('the derived step target is the coupling, and it lands where the app expects', () => {
  // The two figures the app's own contract test holds up as sensible: a
  // low-calorie plan gets 6,000 steps, an ordinary one 8,000.
  assert.equal(deriveStepsPerDay(1800), 6000);
  assert.equal(deriveStepsPerDay(2200), 8000);

  // Monotonic: more calories can never buy fewer steps.
  let previous = -1;
  for (let kcal = 1000; kcal <= 6000; kcal += 100) {
    const steps = deriveStepsPerDay(kcal);
    assert.ok(steps >= previous, `steps fell from ${previous} to ${steps} at ${kcal} kcal`);
    previous = steps;
    assert.ok(steps >= 2000 && steps <= 25000, `${steps} at ${kcal} kcal is out of bounds`);
    assert.equal(steps % 500, 0, 'the step target must land on the slider step');
  }
});

test('the kcal floor is the eating-disorder guard, rounded up to the step', () => {
  const bounds = boundsFor(TARGET);

  // Never below BMR (1674) and never below the male floor (1500); rounded UP
  // to the 50 kcal step so every reachable value stays at or above both.
  assert.equal(bounds.kcal.min, 1700);
  assert.ok(bounds.kcal.min >= 1674);
  assert.ok(bounds.kcal.min >= 1500);
  assert.equal(bounds.kcal.min % 50, 0);

  // The ceiling is a multiple of maintenance with an absolute floor, so a
  // small maintenance figure cannot cap the slider under the target itself.
  assert.equal(bounds.kcal.max, 4500);
  assert.ok(bounds.kcal.max > bounds.kcal.min);

  assert.deepEqual(bounds.stepsPerDay, { min: 2000, max: 25000, step: 500 });
  assert.deepEqual(bounds.sleepMinutes, { min: 300, max: 540, step: 15 });
  // Mirrors goalService, so the plan screen's + and - buttons can never
  // disagree with the ring on how many sessions a week are legal.
  assert.deepEqual(bounds.sessionsPerWeek, { min: 1, max: 14, step: 1 });
});

test('a maintenance figure below the floor cannot invert the slider', () => {
  const bounds = boundsFor({
    ...TARGET,
    inputs: { ...TARGET.inputs, bmrKcal: 1900, maintenanceKcal: 1950 },
  });
  assert.ok(
    bounds.kcal.max > bounds.kcal.min,
    `max ${bounds.kcal.max} must stay above min ${bounds.kcal.min}`,
  );
});

test('the week is spread across weekdays rather than packed into the front', () => {
  const plan = buildWorkout(4, ['lose_fat']);

  // Monday first, and two hard days never back to back: the pattern skips
  // Tuesday and Friday for the first four sessions.
  assert.deepEqual(plan.map((s) => s.weekday), [1, 3, 4, 6]);
  assert.deepEqual(
    plan.map((s) => s.title),
    ['Zone 2 cardio', 'Full body circuit', 'Intervals', 'Strength basics'],
  );
  for (const slot of plan) {
    assert.ok(slot.weekday >= 1 && slot.weekday <= 7);
    assert.ok(slot.title.length > 0);
    assert.ok(slot.intensity.length > 0);
  }
});

test('the session count is honoured, including a two-a-day week', () => {
  assert.equal(buildWorkout(1, []).length, 1);
  assert.equal(buildWorkout(7, ['build_muscle']).length, 7);
  // Above seven the weekday pattern wraps rather than dropping the overflow:
  // ten sessions a week is real, and a plan that silently shows seven of them
  // is lying about the week it was asked for.
  assert.equal(buildWorkout(10, ['general_health']).length, 10);
  assert.equal(buildWorkout(0, []).length, 0);
});

test('the menu follows the goal, and an unknown goal falls back rather than emptying', () => {
  const muscle = buildWorkout(3, ['build_muscle']);
  assert.deepEqual(muscle.map((s) => s.title), ['Push', 'Pull', 'Legs']);

  // A goal the menu does not cover still produces sessions - a plan with an
  // empty workout block is a screen that tells the user to train and not how.
  const unknown = buildWorkout(3, ['some_future_goal']);
  assert.equal(unknown.length, 3);
  assert.equal(unknown[0].title, 'Full body');
});

// ---- Reading --------------------------------------------------------------

test('a first read derives the plan from the target and writes nothing', async () => {
  const prisma = fakePrisma();

  const plan = await getPlan({ prisma, userId: 7 });

  assert.equal(prisma.writes.length, 0, 'a read must never write');
  assert.equal(plan.kcal, 2200);
  // Derived, because nobody has saved a step target yet.
  assert.equal(plan.stepsPerDay, 8000);
  assert.equal(plan.sleepMinutes, 420);
  assert.equal(plan.sessionsPerWeek, 3, 'the neutral default, no WeeklyGoal row');
  assert.equal(plan.adjustedBy.length, 0);
  assert.equal(plan.rulesVersion, 'v1');
  assert.equal(plan.workout.length, 3);
});

test('nutrition is derived, never echoed: the client cannot supply it', async () => {
  const prisma = fakePrisma();

  const plan = await previewPlan({
    prisma,
    userId: 7,
    // Four values, exactly what the app sends. No macros among them.
    draft: { kcal: 3000, stepsPerDay: 6000, sleepMinutes: 420, sessionsPerWeek: 4 },
  });

  // Re-split for the 3,000 kcal actually on the table, not for the target's
  // stored 2,200 - and through the same function computeTargets uses, so the
  // targets screen and the plan screen cannot show different carbs.
  assert.equal(plan.kcal, 3000);
  assert.equal(plan.fatG, Math.round((3000 * 0.28) / 9));
  assert.equal(
    plan.carbsG,
    Math.round((3000 - 130 * 4 - plan.fatG * 9) / 4),
  );
  assert.equal(plan.fibreG, Math.round((3000 / 1000) * 14));

  // These three come off the stored target untouched: body weight and age set
  // them, not the calorie budget, so dragging the kcal slider must not move
  // the number that matters most.
  assert.equal(plan.proteinG, 130);
  assert.equal(plan.waterMl, 3000);
  assert.deepEqual(plan.micros, { ironMg: 18, magnesiumMg: 340 });

  assert.equal(plan.sessionsPerWeek, 4);
  assert.equal(plan.workout.length, 4);
  assert.equal(prisma.writes.length, 0, 'a preview must never write');
});

test('a saved plan outside the bounds is clamped on read, and names what moved', async () => {
  const prisma = fakePrisma({
    saved: { kcal: 1000, stepsPerDay: 99999, sleepMinutes: 420 },
    weekly: { userId: 7, sessionsPerWeek: 3, setByUser: true },
  });

  const plan = await getPlan({ prisma, userId: 7 });

  // The floor moved because the person's weight did. A GET that refused here
  // would leave the screen with no plan and nothing to fix.
  assert.equal(plan.kcal, 1700);
  assert.equal(plan.stepsPerDay, 25000);
  assert.deepEqual(plan.adjustedBy, ['kcal', 'stepsPerDay']);
  assert.equal(plan.sleepMinutes, 420);
  assert.equal(prisma.writes.length, 0, 'the read must not write the clamp back');
});

test('a plan with no target refuses instead of inventing numbers', async () => {
  const prisma = fakePrisma({ target: null });

  await assert.rejects(
    () => getPlan({ prisma, userId: 7 }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'PRESCRIPTION_UNAVAILABLE');
      assert.match(err.message, /Set up your details/);
      return true;
    },
  );
});

// ---- Preview and save -----------------------------------------------------

test('an out-of-range value is a refusal, not a silent clamp', async () => {
  const prisma = fakePrisma();

  await assert.rejects(
    () => previewPlan({ prisma, userId: 7, draft: { stepsPerDay: 80000 } }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'PRESCRIPTION_OUT_OF_RANGE');
      // The screen keeps its sliders where the user left them and puts this
      // sentence next to the button; losing it turns a precise refusal into a
      // generic toast over a form still showing the refused number.
      assert.match(err.message, /outside the range/);
      assert.match(err.message, /25,000/);
      return true;
    },
  );
});

test('a value that is not a number at all is refused too', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => previewPlan({ prisma, userId: 7, draft: { kcal: 'lots' } }),
    (err) => err.code === 'PRESCRIPTION_OUT_OF_RANGE',
  );
});

test('save persists the three adjustable numbers and returns the plan', async () => {
  const prisma = fakePrisma();

  const plan = await savePlan({
    prisma,
    userId: 7,
    draft: { kcal: 2350, stepsPerDay: 9000, sleepMinutes: 450, sessionsPerWeek: 4 },
  });

  assert.equal(prisma.writes.length, 2);
  const [saved] = prisma.writes.filter((w) => w.model === 'prescription');
  assert.equal(saved.args.where.userId, 7);
  assert.equal(saved.args.update.kcal, 2350);
  assert.equal(saved.args.update.stepsPerDay, 9000);
  assert.equal(saved.args.update.sleepMinutes, 450);
  assert.equal(saved.args.update.rulesVersion, 'v1');

  // The session count lands in WeeklyGoal, which is where the home ring reads
  // it. One number, one row - a second copy here is how the ring and the plan
  // screen come to disagree.
  const goal = prisma.writes.find((w) => w.model === 'weeklyGoal');
  assert.ok(goal, 'the session count must reach WeeklyGoal');
  assert.equal(goal.args.update.sessionsPerWeek, 4);
  assert.equal(goal.args.update.setByUser, true);

  assert.equal(plan.kcal, 2350);
  assert.equal(plan.workout.length, 4);
  // The save returns the same shape as the GET, so the screen needs no second
  // parser to show what it just wrote.
  assert.deepEqual(Object.keys(plan.bounds).sort(), [
    'kcal',
    'sessionsPerWeek',
    'sleepMinutes',
    'stepsPerDay',
  ]);
});

test('a partial save leaves the weekly goal alone', async () => {
  const prisma = fakePrisma({ saved: { kcal: 2200, stepsPerDay: 8000, sleepMinutes: 420 } });

  const plan = await savePlan({ prisma, userId: 7, draft: { kcal: 2350 } });

  // A save that did not carry a session count must not mark an untouched goal
  // as explicitly chosen - `setByUser` is what stops onboarding re-deriving it.
  assert.equal(prisma.writes.some((w) => w.model === 'weeklyGoal'), false);
  assert.equal(plan.sessionsPerWeek, 3);
  assert.equal(plan.kcal, 2350);
  // The saved step target is carried over rather than re-derived: the person
  // chose it, and the coupling only ever fills in a value nobody has set.
  assert.equal(plan.stepsPerDay, 8000);
});

test('the bounds that come back are the ones the refusal used', async () => {
  const prisma = fakePrisma();

  const plan = await getPlan({ prisma, userId: 7 });

  await assert.rejects(
    () => previewPlan({ prisma, userId: 7, draft: { kcal: plan.bounds.kcal.max + 50 } }),
    (err) => err.code === 'PRESCRIPTION_OUT_OF_RANGE',
  );
  await assert.rejects(
    () => previewPlan({ prisma, userId: 7, draft: { sleepMinutes: plan.bounds.sleepMinutes.min - 15 } }),
    (err) => err.code === 'PRESCRIPTION_OUT_OF_RANGE',
  );
  await assert.rejects(
    () => previewPlan({ prisma, userId: 7, draft: { sessionsPerWeek: plan.bounds.sessionsPerWeek.max + 1 } }),
    (err) => err.code === 'PRESCRIPTION_OUT_OF_RANGE',
  );
});
