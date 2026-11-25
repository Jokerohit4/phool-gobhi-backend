import { COUNTED_WORKOUT_WHERE, isoDayIST, loggingDayStart, shiftDay } from '../../utils/sessionDay.js';
import { sumFoodLogs } from '../ledger/nutritionService.js';
import { foodTargetProgress } from '../ledger/foodTargetProgress.js';
import { getConsentStatusService } from '../consentService.js';
import { hasBiometricConsentService } from '../biometricConsentService.js';
import { hasCoachScopeService } from '../coachConsentService.js';
import { getNutritionConsentService } from '../ledger/ledgerConsentService.js';
import { activeDoctorPlans, applyDoctorTargets } from '../ledger/doctorPlan.js';

export async function goalActivitySources(userId, days) {
  const keys = new Set(days.flatMap(day => day.tasks.map(task => task.key)));
  const [food, body, device, water] = await Promise.all([
    (keys.has('calories') || keys.has('protein')) && getNutritionConsentService(userId),
    (keys.has('steps') || keys.has('sleep')) && hasBiometricConsentService(userId),
    (keys.has('steps') || keys.has('sleep') || keys.has('walk')) && getConsentStatusService(userId),
    keys.has('water') && hasCoachScopeService(userId, 'basic'),
  ]);
  return { food: food?.granted === true, body: Boolean(body), device: device?.granted === true, water: Boolean(water) };
}

export async function readGoalActivity(prisma, userId, days, permissions) {
  if (!days.length) return {};
  const range = { gte: days[0].date, lte: days.at(-1).date };
  const keys = new Set(days.flatMap(day => day.tasks.map(task => task.key)));
  const hasFood = permissions.food && (keys.has('calories') || keys.has('protein'));
  const [activity, body, water, food, workouts, walks, doctorPlans] = await Promise.all([
    permissions.device && keys.has('steps')
      ? prisma.dailyActivityMetric.findMany({ where: { userId, date: range }, select: { date: true, steps: true } }) : [],
    (permissions.body || permissions.device) && (keys.has('steps') || keys.has('sleep'))
      ? prisma.biometricEntry.findMany({
        where: { userId, localDate: range, metric: { in: ['steps', 'sleep_minutes'] },
          ...(permissions.device && permissions.body ? {} : {
            source: permissions.body ? 'manual' : { in: ['healthkit', 'health_connect'] },
          }) },
        select: { localDate: true, metric: true, value: true },
      }) : [],
    permissions.water && keys.has('water')
      ? prisma.waterLog.findMany({ where: { userId, localDate: range }, select: { localDate: true, ml: true } }) : [],
    hasFood ? prisma.foodLog.findMany({
      where: { userId, localDate: range }, select: { localDate: true, slot: true, nutrients: true },
    }) : [],
    [...keys].some(key => key.startsWith('workout-'))
      ? prisma.workoutSession.findMany({
        where: { userId, localDate: range, ...COUNTED_WORKOUT_WHERE }, select: { localDate: true },
      }) : [],
    keys.has('walk') ? prisma.exerciseRecord.findMany({
      where: {
        userId, type: { in: ['walk', 'walking'] },
        ...(!permissions.device ? { source: { in: ['manual', 'gps_tracker'] } } : {}),
        startedAt: {
          gte: loggingDayStart(range.gte),
          lt: loggingDayStart(shiftDay(range.lte, 1)),
        },
      }, select: { startedAt: true, durationSeconds: true },
    }) : [],
    hasFood ? activeDoctorPlans(prisma, userId, days.map(day => day.date)) : new Map(),
  ]);
  const byDate = new Map(days.map(day => [day.date, {
    steps: 0, sleep: 0, water: 0, workout: 0, walkSeconds: 0, food: [],
  }]));
  for (const row of activity) {
    const day = byDate.get(row.date);
    if (day) day.steps = Math.max(day.steps, row.steps ?? 0);
  }
  for (const row of body) {
    const day = byDate.get(row.localDate);
    const key = row.metric === 'sleep_minutes' ? 'sleep' : 'steps';
    if (day) day[key] = Math.max(day[key], Number(row.value));
  }
  for (const row of water) {
    const day = byDate.get(row.localDate);
    if (day) day.water += row.ml;
  }
  for (const row of food) byDate.get(row.localDate)?.food.push(row);
  for (const row of workouts) {
    const day = byDate.get(row.localDate);
    if (day) day.workout++;
  }
  for (const row of walks) {
    const day = byDate.get(isoDayIST(row.startedAt));
    if (day) day.walkSeconds = Math.max(day.walkSeconds, row.durationSeconds);
  }
  return Object.fromEntries(days.map(({ date, tasks, nutrition }) => {
    const day = byDate.get(date);
    const food = day.food.length ? sumFoodLogs(day.food) : null;
    const earned = food && nutrition ? foodTargetProgress(
      food.totals, applyDoctorTargets(
        { kcal: nutrition.kcal, proteinG: nutrition.protein }, doctorPlans.get(date),
      ),
    ) : {};
    const completed = [];
    for (const { key, amount } of tasks) {
      if (key.startsWith('workout-')) {
        if (day.workout > 0) { day.workout--; completed.push(key); }
      } else if (
        (key === 'walk' && day.walkSeconds >= amount * 60) ||
        (key === 'calories' && earned.caloriesMet) ||
        (key === 'protein' && earned.proteinMet) ||
        (['steps', 'sleep', 'water'].includes(key) && day[key] >= amount)
      ) completed.push(key);
    }
    return [date, completed];
  }).filter(([, keys]) => keys.length));
}
