import { addDays, dayString, dayToDate } from '../../utils/sessionDay.js';

const goalDefaults = {
  weight_loss: 'portions', muscle_gain: 'protein', general_fitness: 'routine',
  flexibility_yoga: 'mobility', sports_training: 'practice', rehabilitation: 'short_sessions',
  whole_health: 'daily_habits', immune_health: 'food_variety', healthy_ageing: 'balance',
  sleep: 'regular_schedule', energy: 'breaks', balanced_eating: 'meal_planning', hydration: 'remember',
  mood_stress: 'unwind', digestion: 'meal_rhythm', daily_movement: 'sitting_breaks',
};

export const GOAL_HABITS = new Set([
  ...Object.values(goalDefaults), 'walking', 'strength', 'endurance', 'balance', 'yoga',
  'speed', 'confidence', 'health_tracking', 'consistency', 'sleep', 'activity',
  'wind_down', 'rested', 'mornings', 'afternoon', 'regular_meals', 'carry_water',
  'track', 'breathing', 'patterns', 'food_patterns', 'fibre', 'steps', 'buddy', 'simple_food',
]);

export const GOAL_WINDOWS = new Set(['morning', 'afternoon', 'evening', 'late_night', 'flexible']);
export const GOAL_DIETS = new Set(['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain', 'high_protein', 'keto', 'intermittent_fasting', 'other']);
const frequencies = { one_two: 2, three_four: 3, five_plus: 5 };
const stepTargets = { mostly_seated: 4000, mixed: 5500, mostly_on_feet: 6500, variable_schedule: 4500 };
const sleepTargets = { under_five: 360, five_to_six: 390, six_to_seven: 420, seven_to_nine: 480, over_nine: 480, varies: 420 };
const mealFocus = new Set(['portions', 'protein', 'food_variety', 'meal_planning', 'regular_meals', 'meal_rhythm', 'food_patterns', 'fibre']);
const mobilityFocus = new Set(['mobility', 'balance', 'yoga']);

function bounded(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : null;
}

function weekdays(today, count, offset = 0) {
  const first = addDays(dayToDate(today), offset).getUTCDay();
  return Array.from({ length: count }, (_, index) => (first + Math.floor(index * 7 / count)) % 7);
}

const move = (name, sets, reps) => ({ name, sets, reps });
const timed = (name, sets, seconds) => ({ name, sets, seconds });

function starter(location, focus, sets, alternate) {
  if (focus === 'sport') return {
    title: 'Easy sports practice',
    exercises: [timed('Easy warm-up', 1, 60), timed('Practice a familiar drill', sets, 60)],
  };
  if (focus === 'mobility') return {
    title: 'Mobility and balance',
    exercises: [move('Shoulder circles', sets, 6), timed('Supported balance hold', sets, 20)],
  };
  if (location === 'gym') return {
    title: alternate ? 'Gym upper body' : 'Gym full body',
    exercises: alternate
      ? [move('Machine chest press', sets, 8), move('Lat pulldown', sets, 8), move('Seated row', sets, 8)]
      : [move('Leg press', sets, 8), move('Seated row', sets, 8), move('Machine chest press', sets, 8)],
  };
  return {
    title: location === 'elsewhere' ? 'Equipment-free strength'
      : alternate ? 'Home strength and balance' : 'Home strength',
    exercises: alternate
      ? [move('Supported step-up', sets, 6), move('Wall push-up', sets, 8), timed('Supported balance hold', 1, 20)]
      : [move('Chair sit-to-stand', sets, 8), move('Wall push-up', sets, 8), move('Calf raise', sets, 10)],
  };
}

export function suggestGoalPlan({
  profile = {}, health = {}, body = {}, sensitive = {}, quitReason, seed = {}, today,
  hasConfirmedReport = false, includeWellnessGoals = false,
}) {
  const wellness = profile.workoutIntent === 'wellness_only' ||
    (!profile.workoutIntent && profile.appMode === 'wellness_tracker');
  const preferences = (profile.goalPreferences ?? []).filter((entry) => typeof entry === 'string');
  const motivations = health.broughtHere ?? [];
  const diet = health.followsDiet !== false && GOAL_DIETS.has(health.dietType) ? health.dietType : null;
  const fitness = [
    ...(wellness ? [] : profile.fitnessGoals ?? []),
    ...(wellness || includeWellnessGoals ? profile.wellnessFocuses ?? [] : []),
  ];
  const goals = [...new Set([...fitness, ...preferences.filter((key) => ['whole_health', 'immune_health', 'healthy_ageing'].includes(key))])];
  if (!goals.length) {
    const motivationGoals = { lose_weight: 'weight_loss', build_muscle: 'muscle_gain', get_fitter: 'general_fitness', stay_consistent: 'whole_health', feel_better: 'whole_health' };
    goals.push(...new Set(motivations.map((key) => motivationGoals[key]).filter(Boolean)));
  }
  const requestedPrimary = preferences.find((entry) => entry.startsWith('primary/'))?.slice('primary/'.length);
  const primary = goals.includes(requestedPrimary) ? requestedPrimary : goals[0];
  const type = primary === 'weight_loss' && !wellness ? 'weight' : primary === 'muscle_gain' && !wellness ? 'appearance' : 'routine';
  const habits = new Set(goals.flatMap((key) => {
    const details = preferences.filter((value) => value.startsWith(key + '/')).map((value) => value.split('/')[1]).filter((value) => GOAL_HABITS.has(value));
    return details.length ? details : [goalDefaults[key]].filter(Boolean);
  }));
  if (motivations.includes('stay_consistent')) habits.add('consistency');
  if (quitReason === 'alone' || motivations.includes('find_a_buddy')) habits.add('buddy');
  if (quitReason === 'no_results') habits.add('health_tracking');
  if (quitReason === 'time') habits.add('short_sessions');
  if (diet && ![...habits].some((key) => mealFocus.has(key))) habits.add('meal_planning');
  if (health.whoCooks === 'outside' || health.whoCooks === 'family') habits.add('simple_food');

  const occupied = ['8_to_10', 'over_10', 'irregular'].includes(health.workingHours) || health.occupation === 'shifts';
  const short = occupied || habits.has('short_sessions') || quitReason === 'travelling';
  const birth = typeof profile.dateOfBirth === 'string' ? profile.dateOfBirth.slice(0, 10) : null;
  const age = birth ? Number(today.slice(0, 4)) - Number(birth.slice(0, 4)) -
    (today.slice(5) < birth.slice(5) ? 1 : 0) : null;
  const gettingBack = profile.experienceLevel === 'restarting_after_break';
  const cautious = quitReason === 'injury' || goals.includes('rehabilitation') || (age >= 65 && profile.currentlyWorksOut !== true);
  const experienced = !gettingBack && profile.currentlyWorksOut !== false &&
    profile.trainingTenure !== 'under_3_months' &&
    (profile.experienceLevel === 'experienced' || ['one_to_3_years', 'over_3_years'].includes(profile.trainingTenure));
  const rawLocation = profile.trainingLocationPref;
  const other = String(profile.trainingLocationOther ?? '').toLowerCase();
  const gym = ['gym', 'fitness_centre'].includes(rawLocation) ||
    (rawLocation === 'other' && /\b(gym|weights room)\b/.test(other)) ||
    (!rawLocation && (profile.linkedGymId || profile.homeUnclaimedGymId));
  const gymThrough = typeof profile.gymSubscriptionEndDate === 'string' ? profile.gymSubscriptionEndDate.slice(0, 10) : null;
  const renewal = gym && !profile.linkedGymId && gymThrough && gymThrough < dayString(addDays(dayToDate(today), 9));
  const location = gym && !renewal && quitReason !== 'travelling'
    ? 'gym' : rawLocation === 'sports' ? 'sports'
    : rawLocation === 'other' && !renewal ? 'elsewhere' : 'home';
  const sports = wellness ? [] : (profile.sportsPlayed ?? []).filter((key) => key !== 'other');
  const sport = location === 'sports' || goals.includes('sports_training');
  if (sport || sports.length) habits.add('practice');
  const mobility = cautious ||
    ([...habits].some((key) => mobilityFocus.has(key)) && !goals.includes('muscle_gain') && !habits.has('strength'));
  const workoutFocus = mobility ? 'mobility' : sport ? 'sport' : 'strength';

  const knownFrequency = frequencies[profile.weeklyFrequencyIntent];
  // A free-text concern can describe a restriction on any movement. Until it
  // has been reviewed, avoid suggesting exercises the person may be unable to do.
  const requiresActivityReview = Boolean(sensitive.hasIssue);
  const workoutCount = wellness || requiresActivityReview ? 0 : cautious ? Math.min(2, knownFrequency ?? 2)
    : knownFrequency ?? (experienced ? 3 : 2);
  const sessionMinutes = cautious || short ? 15
    : gettingBack || profile.trainingTenure === 'under_3_months' ? 20
    : experienced ? profile.trainingTenure === 'over_3_years' ? 40 : 35
    : 25;
  const compatibleSlots = location === 'gym' && workoutFocus === 'strength' && experienced && !short
    ? (seed.workouts ?? []).filter((slot) => slot.title && slot.exercises?.length) : [];
  const used = new Set();
  const workouts = weekdays(today, workoutCount, 1).map((weekday, index) => {
    const existing = compatibleSlots.find((slot) => slot.weekday === weekday && !used.has(slot.id));
    if (existing) used.add(existing.id);
    const template = existing ?? starter(location, workoutFocus, cautious || gettingBack || short ? 1 : experienced ? 3 : 2,
      quitReason === 'boredom' && index % 2 === 1);
    return {
      id: `personal-${index}`, title: template.title, weekday,
      ...(workoutFocus === 'sport' && sports.length ? { sport: sports[index % sports.length] } : {}),
      minutes: existing ? Math.min(existing.minutes, sessionMinutes) : sessionMinutes,
      exercises: template.exercises,
    };
  });

  const dayPattern = profile.wellnessDayPattern ||
    ({ desk: 'mostly_seated', on_feet: 'mostly_on_feet', shifts: 'variable_schedule' })[health.occupation];
  const walkingFocus = habits.has('walking') || goals.includes('daily_movement') || habits.has('endurance') || habits.has('activity');
  let steps = stepTargets[dayPattern] ?? bounded(seed.steps, 500, 25000) ?? (experienced ? 6500 : 5000);
  if (cautious) steps = Math.min(steps, 4000);
  const walkCount = requiresActivityReview ? 0 : cautious ? 2 : walkingFocus ? 4 : wellness && dayPattern === 'variable_schedule' ? 2 : 3;
  const window = GOAL_WINDOWS.has(profile.freeTimeWindow) ? profile.freeTimeWindow
    : occupied || dayPattern === 'variable_schedule' ? 'flexible'
    : habits.has('afternoon') ? 'afternoon' : habits.has('mornings') ? 'morning' : null;
  const weightLossKg = type === 'weight' && Number.isFinite(profile.weightLossTargetKg) &&
    profile.weightLossTargetKg > 0 && profile.weightLossTargetKg <= 350 &&
    (!Number.isFinite(body.weightKg) || body.weightKg - profile.weightLossTargetKg >= 20) ? profile.weightLossTargetKg : null;
  const targetWeight = weightLossKg && Number.isFinite(body.weightKg) && body.weightKg - weightLossKg >= 20
    ? Math.round((body.weightKg - weightLossKg) * 10) / 10 : null;
  const nutrition = seed.nutrition;
  const validNutrition = !cautious && Number.isInteger(nutrition?.kcal) && nutrition.kcal >= 1200 && nutrition.kcal <= 4500 &&
    Number.isInteger(nutrition.protein) && nutrition.protein >= 1 && nutrition.protein <= 400 &&
    Number.isInteger(nutrition.fat) && nutrition.fat >= 1 && nutrition.fat <= 250 &&
    nutrition.protein * 4 + nutrition.fat * 9 <= nutrition.kcal;
  return {
    primary: primary ?? null,
    draft: {
      type, days: 10, steps, walkDays: weekdays(today, walkCount),
      walkMinutes: cautious || short || dayPattern === 'mostly_seated' ? 10 : walkingFocus ? 20 : 15,
      waterMl: bounded(seed.waterMl, 500, 4500) ?? 2000,
      sleepMinutes: sleepTargets[profile.wellnessSleepPattern] ?? bounded(seed.sleepMinutes, 240, 720) ?? 420,
      workouts, nutrition: validNutrition ? nutrition : null, targetWeight, weightLossKg,
      priority: type === 'appearance' ? 'strength' : null,
      habits: [...habits].slice(0, 32), window,
      mealCount: bounded(health.mealsPerDay, 1, 8), diet,
    },
    // Return general safety/context flags for this review only. Never copy
    // allergies, medication names, raw concern text or the date of birth into the plan.
    context: {
      wellness, location: wellness ? null : location,
      gymRenewal: Boolean(renewal), short: short || gettingBack,
      clinicianContext: Boolean(sensitive.hasIssue || motivations.includes('doctor_suggested') || quitReason === 'injury'),
      allergyContext: sensitive.allergyStatus === 'has',
      hasConfirmedReport,
    },
  };
}
