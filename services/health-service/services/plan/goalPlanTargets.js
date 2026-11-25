import { isoDayIST } from '../../utils/sessionDay.js';
import { currentNutritionTarget } from '../ledger/currentTarget.js';

export function applyGoalDayTargets(target, day) {
  if (!day) return target;
  const write = { ...target };
  const protectedFields = new Set(target?.doctorPlan?.targetFields ?? []);
  const apply = (key, value) => {
    if (value != null && !protectedFields.has(key)) write[key] = value;
  };
  if (day.nutrition) {
    const { kcal, protein, carbs, fat } = day.nutrition;
    apply('kcal', kcal);
    apply('proteinG', protein);
    apply('carbsG', carbs);
    apply('fatG', fat);
  }
  apply('waterMl', day.tasks.find(task => task.key === 'water')?.amount);
  apply('stepsPerDay', day.tasks.find(task => task.key === 'steps')?.amount);
  apply('sleepMinutes', day.tasks.find(task => task.key === 'sleep')?.amount);
  if (!target && !day.nutrition) return null;
  return { ...write, ...(day.nutrition ? { source: target?.doctorPlan ? target.source : 'goal_plan' } : {}) };
}

export async function nutritionTargetForGoalDay(prisma, userId, day = isoDayIST()) {
  const [base, plan] = await Promise.all([
    currentNutritionTarget(prisma, userId, day),
    savedGoalSchedule(prisma, userId),
  ]);
  return applyGoalDayTargets(base, plan.find(entry => entry.date === day));
}

export async function savedGoalSchedule(prisma, userId) {
  const plan = await prisma.goalPlan?.findUnique({ where: { userId }, select: { schedule: true } });
  return plan?.schedule ?? [];
}

export function scheduledWorkouts(schedule, from, to) {
  return schedule.filter(day => day.date >= from && day.date <= to)
    .flatMap(day => day.tasks).filter(task => task.key.startsWith('workout-')).length;
}
