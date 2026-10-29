import { POINTS } from '../ledger/constants.js';

export const isDenominatorDay = day => !day.isFuture && !day.paused;
export const isCompleteFoodDay = status => ['on_target', 'under', 'over', 'no_target'].includes(status);
export function foodStatus({ isToday = false, logCount, mealSlotsCovered, pendingCount, kcal, targetKcal }) {
  if (isToday) return 'in_progress';
  if (!logCount) return 'unlogged';
  if (mealSlotsCovered < 2 || pendingCount > 0) return 'partial';
  if (!(targetKcal > 0)) return 'no_target';
  const ratio = kcal / targetKcal;
  if (Math.abs(1 - ratio) <= POINTS.caloriesOffTargetRatio) return 'on_target';
  return ratio < 1 ? 'under' : 'over';
}
export const waterMet = (ml, targetMl) => targetMl > 0 ? ml >= targetMl : false;
export const average = values => values.length ? Math.round(values.reduce((a,b) => a+b, 0) / values.length * 10) / 10 : null;

export function summarizeDays(days, layers, workoutGoal, completedWorkouts) {
  const eligible = days.filter(isDenominatorDay);
  const denominatorDays = eligible.length;
  const knownPlan = eligible.every(d => d.plan?.done != null && d.plan?.total != null);
  const totals = {};
  if (layers.includes('plan')) totals.plan = {
    daysTargetHit: eligible.filter(d => d.plan?.targetHit === true).length,
    done: knownPlan ? eligible.reduce((n,d) => n+d.plan.done, 0) : null,
    total: knownPlan ? eligible.reduce((n,d) => n+d.plan.total, 0) : null,
    denominatorDays,
    source: eligible.some(d => d.plan?.source === 'snapshot') ? 'snapshot' : 'live',
  };
  if (layers.includes('food')) {
    const complete = eligible.filter(d => isCompleteFoodDay(d.food.status));
    totals.food = {
      daysLogged: eligible.filter(d => d.food.logCount > 0).length,
      daysComplete: complete.length,
      daysOnTarget: complete.filter(d => d.food.status === 'on_target').length,
      weekKcal: complete.reduce((n,d) => n+d.food.kcal, 0),
      weekTargetKcal: complete.reduce((n,d) => n+(d.food.targetKcal ?? 0), 0),
      avgKcalCompleteDays: average(complete.map(d => d.food.kcal)), denominatorDays,
    };
  }
  if (layers.includes('water')) totals.water = {
    daysMet: eligible.filter(d => !d.isToday && d.water.met).length,
    avgMl: average(eligible.map(d => d.water.ml)), denominatorDays,
  };
  if (layers.includes('workouts')) totals.workouts = { completed: completedWorkouts, goal: workoutGoal.sessionsPerWeek, source: workoutGoal.source };
  return totals;
}
