import assert from 'node:assert/strict';
import test from 'node:test';
import { readGoalActivity } from '../services/plan/goalPlanActivity.js';
import { applyGoalDayTargets } from '../services/plan/goalPlanTargets.js';
import { goalPlanView } from '../services/plan/goalPlanService.js';

const day = '2026-11-25';
const label = (key, amount, points = 10) => ({ key, amount, points });
const schedule = [{ date: day, nutrition: { kcal: 2000, protein: 95, carbs: 270, fat: 60 }, tasks: [
  label('steps', 4500), label('sleep', 420), label('water', 1000),
  label('walk', 10), label('workout-first', 25, 20), label('workout-second', 30, 20),
  label('calories', 2000), label('protein', 95), label('habit-breathing', null, 5),
] }];

test('real logs count once and leave subjective habits for a check-in', async () => {
  const prisma = {
    dailyActivityMetric: { findMany: async () => [{ date: day, steps: 4800 }] },
    biometricEntry: { findMany: async () => [{ localDate: day, metric: 'sleep_minutes', value: 450 }] },
    waterLog: { findMany: async () => [{ localDate: day, ml: 500 }, { localDate: day, ml: 500 }] },
    foodLog: { findMany: async () => [{ localDate: day, slot: 'lunch', nutrients: { kcal: 2000, proteinG: 100 } }] },
    workoutSession: { findMany: async () => [{ localDate: day }] },
    exerciseRecord: { findMany: async () => [{ startedAt: new Date(day + 'T08:00:00Z'), durationSeconds: 720 }] },
  };
  const activity = await readGoalActivity(prisma, 42, schedule, { device: true, body: true, water: true, food: true });
  assert.deepEqual(activity[day], ['steps', 'sleep', 'water', 'walk', 'workout-first', 'calories', 'protein']);
  const { plan } = goalPlanView({
    startDate: day, draft: { type: 'appearance', walkDays: [], workouts: [] },
    schedule, completions: { [day]: ['steps', 'habit-breathing'] },
  }, day, activity);
  assert.equal(plan.completions[day].filter(key => key === 'steps').length, 1);
  assert.equal(plan.milestone.earned, 20);
});

test('revoked data sources are skipped and manual walk records remain eligible', async () => {
  const prisma = {
    workoutSession: { findMany: async () => [] },
    exerciseRecord: { findMany: async ({ where }) => {
      assert.deepEqual(where.source.in, ['manual', 'gps_tracker']);
      return [];
    } },
  };
  assert.deepEqual(await readGoalActivity(prisma, 42, schedule, {}), {});
});

test('the same day supplies food targets while confirmed clinician fields take priority', () => {
  const base = { kcal: 1900, proteinG: 90, doctorPlan: { targetFields: ['kcal'] } };
  const target = applyGoalDayTargets(base, schedule[0]);
  assert.equal(target.kcal, 1900);
  assert.equal(target.proteinG, 95);
  assert.equal(target.stepsPerDay, 4500);
  assert.equal(target.sleepMinutes, 420);
  assert.deepEqual(applyGoalDayTargets(base, null), base);
});
