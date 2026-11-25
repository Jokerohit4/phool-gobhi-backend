import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestGoalPlan } from '../services/plan/goalPlanPersonalisation.js';
import { buildGoalSchedule, goalPlanView, normalizeGoalDraft, prepareGoalPlan } from '../services/plan/goalPlanService.js';

const today = '2026-11-30';
const suggest = (options = {}) => suggestGoalPlan({ today, ...options });
const valid = (draft) => normalizeGoalDraft({ title: 'My plan', ...draft });

test('wellness-only answers control the actual schedule without carrying over stale training answers', () => {
  const { primary, draft, context } = suggest({
    profile: {
      workoutIntent: 'wellness_only', fitnessGoals: ['muscle_gain'],
      wellnessFocuses: ['sleep', 'mood_stress', 'hydration', 'energy'],
      goalPreferences: ['sleep/wind_down', 'mood_stress/breathing', 'hydration/carry_water', 'energy/afternoon',
        'muscle_gain/protein', 'whole_health', 'whole_health/health_tracking'],
      wellnessDayPattern: 'mostly_seated', wellnessSleepPattern: 'five_to_six',
      trainingLocationPref: 'gym', weeklyFrequencyIntent: 'five_plus',
    },
    seed: { steps: 8000, sleepMinutes: 480, workouts: [{ title: 'Old routine' }] },
  });
  assert.equal(primary, 'sleep');
  assert.equal(context.location, null);
  assert.deepEqual(draft.workouts, []);
  assert.equal(draft.steps, 4000);
  assert.equal(draft.sleepMinutes, 390);
  assert.equal(draft.window, 'afternoon');
  assert.deepEqual(draft.habits, ['wind_down', 'breathing', 'carry_water', 'afternoon', 'health_tracking']);
  const plan = prepareGoalPlan(valid(draft), null, today);
  const keys = new Set(plan.schedule.flatMap((day) => day.tasks.map((task) => task.key)));
  assert.equal(keys.has('habit-wind_down'), true);
  assert.equal(keys.has('habit-protein'), false);
  assert.equal(plan.schedule[0].tasks.find((task) => task.key === 'walk').window, 'afternoon');
  assert.equal(goalPlanView(plan, '2026-12-01').plan.milestone.kind, 'habits');
  assert.equal(goalPlanView(plan, '2026-12-01').plan.milestone.delay, 1);
});

test('weight amount, other location, time constraints and food answers influence the first plan', () => {
  const { draft, context } = suggest({
    profile: {
      fitnessGoals: ['weight_loss', 'muscle_gain'],
      goalPreferences: ['weight_loss/walking', 'muscle_gain/protein'],
      weightLossTargetKg: 8.5, currentlyWorksOut: true, experienceLevel: 'restarting_after_break',
      trainingTenure: 'over_3_years', weeklyFrequencyIntent: 'one_two',
      trainingLocationPref: 'other', trainingLocationOther: 'Apartment gym',
      freeTimeWindow: 'evening',
    },
    body: { weightKg: 92 },
    health: { dietType: 'jain', mealsPerDay: 3, occupation: 'shifts', whoCooks: 'family' },
    sensitive: { allergyStatus: 'has', hasIssue: true, allergies: ['PRIVATE'], label: 'PRIVATE' },
    quitReason: 'time',
  });
  assert.equal(draft.type, 'weight');
  assert.equal(draft.targetWeight, 83.5);
  assert.equal(draft.weightLossKg, 8.5);
  assert.deepEqual(draft.workouts, []);
  assert.deepEqual(draft.walkDays, []);
  assert.equal(context.location, 'gym');
  assert.equal(draft.window, 'evening');
  assert.equal(draft.diet, 'jain');
  assert.equal(draft.mealCount, 3);
  assert.equal(context.clinicianContext, true);
  assert.equal(context.allergyContext, true);
  assert.ok(!JSON.stringify({ draft, context }).includes('PRIVATE'));
  assert.equal(suggest({ profile: { fitnessGoals: ['weight_loss'], weightLossTargetKg: 8.5 } }).draft.targetWeight, null);
});

test('gym access, training history and sport choice produce different exercises and cadence', () => {
  const profile = {
    fitnessGoals: ['muscle_gain'], currentlyWorksOut: true, experienceLevel: 'experienced',
    trainingTenure: 'over_3_years', weeklyFrequencyIntent: 'five_plus', trainingLocationPref: 'gym',
  };
  const gym = suggest({ profile }).draft;
  assert.equal(gym.workouts.length, 5);
  assert.equal(gym.workouts[0].minutes, 40);
  assert.equal(gym.workouts[0].exercises[0].sets, 3);

  const renewal = suggest({ profile: { ...profile, homeUnclaimedGymId: 1, gymSubscriptionEndDate: '2026-12-02' } });
  assert.equal(renewal.context.gymRenewal, true);
  assert.match(renewal.draft.workouts[0].title, /Home/);
  const home = suggest({ profile: { ...profile, trainingLocationPref: 'home', trainingTenure: 'under_3_months' } }).draft;
  assert.match(home.workouts[0].title, /Home/);
  assert.equal(home.workouts[0].minutes, 20);
  const sports = suggest({ profile: {
    ...profile, fitnessGoals: ['sports_training'], trainingLocationPref: 'sports',
    sportsPlayed: ['badminton', 'cricket'], weeklyFrequencyIntent: 'one_two',
  } }).draft;
  assert.deepEqual(sports.workouts.map((workout) => workout.sport), ['badminton', 'cricket']);
  assert.ok(sports.habits.includes('practice'));
});

test('all chosen habits fit in a shortened plan and malformed metadata cannot be saved', () => {
  const { draft } = suggest({
    profile: {
      workoutIntent: 'wellness_only',
      wellnessFocuses: ['sleep', 'energy', 'balanced_eating', 'hydration', 'mood_stress', 'digestion', 'daily_movement'],
      goalPreferences: ['sleep/rested', 'sleep/wind_down', 'mood_stress/breathing', 'daily_movement/sitting_breaks'],
    },
  });
  const days = buildGoalSchedule(valid({ ...draft, days: 7 }), today);
  const taskKeys = new Set(days.flatMap((day) => day.tasks.map(({ key }) => key)));
  assert.ok(draft.habits.length > 7);
  assert.ok(draft.habits.every((habit) => taskKeys.has('habit-' + habit)));
  for (const overrides of [{ habits: ['invented'] }, { window: '06:30' }, { mealCount: 20 }, { diet: 'invented' }]) {
    assert.throws(() => valid({ ...draft, ...overrides }), { status: 400 });
  }
});

test('the explicit primary wins and impossible weight-loss requests cannot be recommended', () => {
  const profile = { fitnessGoals: ['weight_loss', 'muscle_gain'], goalPreferences: ['primary/muscle_gain'], weightLossTargetKg: 60 };
  assert.equal(suggest({ profile }).primary, 'muscle_gain');
  const { draft } = suggest({ profile: { ...profile, goalPreferences: ['primary/weight_loss'] }, body: { weightKg: 60 } });
  assert.equal(draft.targetWeight, null);
  assert.equal(draft.weightLossKg, null);
});
