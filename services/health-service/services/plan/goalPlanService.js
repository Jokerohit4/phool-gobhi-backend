import { addDays, dayString, dayToDate, isoDayIST } from '../../utils/sessionDay.js';
import { isDeepStrictEqual } from 'node:util';
import { GOAL_DIETS, GOAL_HABITS, GOAL_WINDOWS } from './goalPlanPersonalisation.js';

export const MIN_GOAL_DAYS = 7;
export const MAX_GOAL_DAYS = 30;
const TYPES = new Set(['routine', 'weight', 'glucose', 'appearance']);
const PRIORITIES = new Set(['strength', 'posture', 'conditioning']);

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(400, `${label} must be between ${min} and ${max}`);
  return value;
}

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `Enter ${label}`);
  return value.trim();
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = dayToDate(value);
  return Number.isFinite(date.getTime()) && dayString(date) === value;
}

export function normalizeGoalDraft(input) {
  if (!input || !TYPES.has(input.type)) fail(400, 'Choose a goal type');
  const { type } = input;
  if (!Array.isArray(input.walkDays) || !Array.isArray(input.workouts) || input.workouts.length > 7) fail(400, 'Check the activity schedule');
  const walkDays = [...new Set(input.walkDays.map((day) => integer(day, 0, 6, 'Weekday')))].sort();
  const workouts = input.workouts.map((workout, index) => {
    if (!workout || !Array.isArray(workout.exercises) || workout.exercises.length > 12) fail(400, 'Check the workout exercises');
    const id = workout.id ?? `slot-${index}`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,36}$/.test(id)) fail(400, 'Check the workout identifier');
    return {
      id,
      title: text(workout.title, 80, 'a workout name'),
      weekday: integer(workout.weekday, 0, 6, 'Workout day'),
      minutes: integer(workout.minutes, 5, 180, 'Workout minutes'),
      exercises: workout.exercises.map((exercise) => {
        if (!exercise) fail(400, 'Check the workout exercises');
        return {
          name: text(exercise.name, 80, 'an exercise name'),
          sets: integer(exercise.sets, 1, 20, 'Sets'),
          ...(exercise.seconds != null
            ? { seconds: integer(exercise.seconds, 1, 600, 'Seconds') }
            : { reps: integer(exercise.reps, 1, 100, 'Reps') }),
        };
      }),
    };
  });
  if (new Set(workouts.map((workout) => workout.id)).size !== workouts.length) fail(400, 'Check the workout schedule');
  if (type === 'appearance' && !workouts.length) fail(400, 'Choose a strength session for this goal');

  let nutrition = null;
  if (type !== 'glucose' && input.nutrition != null) {
    const kcal = integer(input.nutrition.kcal, 1200, 4500, 'Calories');
    const protein = integer(input.nutrition.protein, 1, 400, 'Protein');
    const fat = integer(input.nutrition.fat, 1, 250, 'Fat');
    const carbs = (kcal - protein * 4 - fat * 9) / 4;
    if (carbs < 0) fail(400, 'Protein and fat exceed the calorie target');
    nutrition = { kcal, protein, fat, carbs: Math.round(carbs * 100) / 100 };
  }
  const reviewDate = type === 'glucose' ? input.reviewDate ?? null : null;
  if (reviewDate !== null && !validDate(reviewDate)) fail(400, 'Check the review date');
  const targetWeight = type === 'weight' ? input.targetWeight ?? null : null;
  if (targetWeight !== null && (!Number.isFinite(targetWeight) || targetWeight <= 0 || targetWeight > 1000)) fail(400, 'Check the weight goal');
  const priority = type === 'appearance' ? input.priority ?? 'strength' : null;
  if (priority && !PRIORITIES.has(priority)) fail(400, 'Choose a training priority');
  const weightLossKg = type === 'weight' ? input.weightLossKg ?? null : null;
  if (weightLossKg != null && (!Number.isFinite(weightLossKg) || weightLossKg <= 0 || weightLossKg > 350)) fail(400, 'Check the weight goal');
  const habits = input.habits ?? [];
  if (!Array.isArray(habits) || habits.length > 32 || habits.some((habit) => !GOAL_HABITS.has(habit))) fail(400, 'Check the plan habits');
  const { window, mealCount, diet } = input;
  if (window != null && !GOAL_WINDOWS.has(window)) fail(400, 'Check the activity time');
  if (diet != null && !GOAL_DIETS.has(diet)) fail(400, 'Check the food preference');
  if (mealCount != null) integer(mealCount, 1, 8, 'Meals per day');
  return {
    type, title: text(input.title, 80, 'a goal'),
    days: integer(input.days, MIN_GOAL_DAYS, MAX_GOAL_DAYS, 'Plan length'),
    steps: integer(input.steps, 500, 25000, 'Steps'),
    walkMinutes: integer(input.walkMinutes, 5, 120, 'Walking minutes'),
    waterMl: integer(input.waterMl, 500, 4500, 'Water'),
    sleepMinutes: integer(input.sleepMinutes, 240, 720, 'Sleep'),
    nutrition, walkDays, workouts, reviewDate, targetWeight, priority,
    ...(weightLossKg == null ? {} : { weightLossKg }),
    ...(habits.length ? { habits: [...new Set(habits)] } : {}),
    ...(window == null ? {} : { window }),
    ...(mealCount == null ? {} : { mealCount }),
    ...(diet == null ? {} : { diet }),
  };
}

function ramp(target, startShare, position, increment = 1) {
  const start = Math.round(target * startShare);
  return Math.min(target, Math.round((start + (target - start) * position) / increment) * increment);
}

// These preferences already have a dated target in the plan.
function separateHabits(draft) {
  return (draft.habits ?? []).filter(habit => !['steps', 'walking', 'track'].includes(habit));
}

export function buildGoalSchedule(draft, startDate) {
  const habits = separateHabits(draft);
  const habitsPerDay = habits.length ? Math.ceil(habits.length / Math.min(10, draft.days)) : 0;
  const activityTime = draft.window ? { window: draft.window } : {};
  return Array.from({ length: draft.days }, (_, index) => {
    const day = addDays(dayToDate(startDate), index);
    const weekday = day.getUTCDay();
    const position = index / (draft.days - 1);
    const tasks = [{ key: 'steps', amount: index === draft.days - 1 ? draft.steps : ramp(draft.steps, 0.8, position, 50), points: 10 }];
    if (draft.walkDays.includes(weekday)) {
      tasks.push({ key: 'walk', amount: ramp(draft.walkMinutes, 0.7, position), points: 10, ...activityTime });
    }
    draft.workouts.forEach((workout) => {
      if (workout.weekday === weekday) {
        tasks.push({ key: `workout-${workout.id}`, amount: ramp(workout.minutes, 0.8, position), points: 20, title: workout.title, exercises: workout.exercises, ...activityTime });
      }
    });
    if (draft.nutrition) {
      tasks.push({ key: 'calories', amount: draft.nutrition.kcal, points: 10 }, { key: 'protein', amount: draft.nutrition.protein, points: 10 });
    }
    if (draft.type === 'glucose') tasks.push({ key: 'meals', points: 10 });
    for (let i = 0; i < habitsPerDay; i++) {
      const habit = habits[(index * habitsPerDay + i) % habits.length];
      tasks.push({ key: `habit-${habit}`, points: 5 });
    }
    tasks.push({ key: 'water', amount: draft.waterMl, points: 5 }, { key: 'sleep', amount: draft.sleepMinutes, points: 5 });
    return {
      date: dayString(day), tasks, nutrition: draft.nutrition,
      ...(draft.mealCount == null ? {} : { mealCount: draft.mealCount }),
      ...(draft.diet == null ? {} : { diet: draft.diet }),
    };
  });
}

export function goalPlanView(row, today = isoDayIST(), automatic = {}) {
  if (!row) return { plan: null, today };
  const startDate = row.startDate ?? row.schedule[0].date;
  const history = row.schedule.filter((day) => day.date < startDate);
  const schedule = row.schedule.filter((day) => day.date >= startDate);
  const completions = { ...row.completions };
  for (const [date, keys] of Object.entries(automatic)) {
    completions[date] = [...new Set([...(completions[date] ?? []), ...keys])];
  }
  const milestoneKind = row.draft.type === 'appearance' ? 'workouts'
    : schedule.some(day => day.tasks.some(task => task.key.startsWith('habit-'))) ? 'habits' : 'walks';
  const goalTask = (task) => milestoneKind === 'workouts' ? task.key.startsWith('workout-')
    : milestoneKind === 'habits' ? task.key.startsWith('habit-') : task.key === 'walk';
  const goalDays = schedule.map((day) => ({ date: day.date, tasks: day.tasks.filter(goalTask) }))
    .filter((day) => day.tasks.length);
  const total = goalDays.flatMap((day) => day.tasks).reduce((sum, task) => sum + task.points, 0);
  let earned = 0;
  let unrecorded = 0;
  for (const day of goalDays) {
    if (day.date > today) break;
    for (const task of day.tasks) {
      if (completions[day.date]?.includes(task.key)) earned += task.points;
      else if (day.date < today) unrecorded++;
    }
  }
  const phaseEnd = schedule.at(-1).date;
  const end = goalDays.at(-1)?.date ?? phaseEnd;
  let estimate = end;
  if (unrecorded) {
    const cadence = milestoneKind === 'workouts'
      ? row.draft.workouts.map((workout) => workout.weekday)
      : row.draft.walkDays;
    let day = end < today ? dayToDate(today) : addDays(dayToDate(end), 1);
    while (unrecorded > 0 && (milestoneKind === 'habits' || cadence.length)) {
      unrecorded -= milestoneKind === 'habits'
        ? Math.max(1, Math.ceil(separateHabits(row.draft).length / Math.min(10, row.draft.days)))
        : cadence.filter((weekday) => weekday === day.getUTCDay()).length;
      estimate = dayString(day);
      day = addDays(day, 1);
    }
  }
  const delay = (dayToDate(estimate) - dayToDate(end)) / 86_400_000;
  const { userId: _, updatedAt: __, ...plan } = row;
  return { plan: {
    ...plan, schedule, history, completions, automatic, expired: phaseEnd < today,
    milestone: { total, earned, delay, estimate, kind: milestoneKind },
  }, today };
}

export function prepareGoalPlan(draft, current, today = isoDayIST()) {
  const expired = current && current.schedule.at(-1).date < today;
  const startDate = expired ? today : current?.startDate ?? today;
  const schedule = buildGoalSchedule(draft, startDate);
  const previous = new Map(current?.schedule.map((day) => [day.date, day]) ?? []);
  const completions = current?.completions ?? {};
  const protectedSchedule = schedule.map((day) => {
    const old = previous.get(day.date);
    if (old && day.date < today) return old;
    const recorded = completions[day.date] ?? [];
    if (!old || !recorded.length) return day;
    const tasks = day.tasks.map((task) => old.tasks.find((entry) => entry.key === task.key && recorded.includes(entry.key)) ?? task);
    for (const task of old.tasks) {
      if (recorded.includes(task.key) && !tasks.some((entry) => entry.key === task.key)) tasks.push(task);
    }
    return { ...day, tasks };
  });
  const history = current?.schedule.filter((day) => day.date < startDate) ?? [];
  return { startDate, draft, schedule: [...history, ...protectedSchedule], completions };
}

export async function saveGoalPlan(prisma, userId, input, today = isoDayIST()) {
  const draft = normalizeGoalDraft(input.draft);
  const current = await prisma.goalPlan.findUnique({ where: { userId } });
  const sameDraft = current && current.schedule.at(-1).date >= today && isDeepStrictEqual(current.draft, draft);
  if (sameDraft) return goalPlanView(current, today);
  if ((current?.revision ?? 0) !== input.revision) {
    fail(409, 'Your plan changed. Reload it and try again.');
  }
  const write = prepareGoalPlan(draft, current, today);
  if (current && write.schedule.at(-1).date < today) fail(400, 'Keep the dates you have already planned');
  if (!current) {
    try {
      return goalPlanView(await prisma.goalPlan.create({ data: { userId, ...write } }), today);
    } catch (error) {
      if (error.code !== 'P2002') throw error;
      const saved = await prisma.goalPlan.findUnique({ where: { userId } });
      if (saved && isDeepStrictEqual(saved.draft, draft)) return goalPlanView(saved, today);
      fail(409, 'Your plan changed. Reload it and try again.');
    }
  }
  const result = await prisma.goalPlan.updateMany({ where: { userId, revision: input.revision }, data: { ...write, revision: { increment: 1 } } });
  if (!result.count) fail(409, 'Your plan changed. Reload it and try again.');
  return goalPlanView({ ...current, ...write, revision: current.revision + 1 }, today);
}

export async function recordGoalTask(prisma, userId, input, today = isoDayIST()) {
  const { date, key, done } = input;
  if (!validDate(date) || date > today || typeof done !== 'boolean' || typeof key !== 'string') fail(400, 'Check the task date and completion');
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await prisma.goalPlan.findUnique({ where: { userId } });
    if (!current?.schedule.find((day) => day.date === date)?.tasks.some((task) => task.key === key)) fail(404, 'Task unavailable');
    const doneTasks = new Set(current.completions[date] ?? []);
    if (doneTasks.has(key) === done) return goalPlanView(current, today);
    if (done) doneTasks.add(key);
    else doneTasks.delete(key);
    const completions = { ...current.completions, [date]: [...doneTasks] };
    const result = await prisma.goalPlan.updateMany({
      where: { userId, revision: current.revision },
      data: { completions, revision: { increment: 1 } },
    });
    if (result.count) return goalPlanView({ ...current, completions, revision: current.revision + 1 }, today);
  }
  fail(409, 'The task changed. Try again.');
}
