import { roundTo, DECIMAL_PLACES } from './constants.js';
import { computeEarns } from './scoreEngine.js';
import { computePortion } from './nutritionService.js';

export function nutritionPoints(logs, target, localDate) {
  const totals = { hasAnyFood: logs.length > 0,
    mealSlotsCovered: new Set(logs.filter(l => ['breakfast', 'lunch', 'dinner'].includes(l.slot)).map(l => l.slot)).size };
  for (const log of logs) {
    if (log.nutrients?.unknown) continue;
    for (const [key, value] of Object.entries(log.nutrients || {})) {
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] = roundTo((totals[key] || 0) + value, DECIMAL_PLACES.nutrients);
    }
  }
  const lines = computeEarns({ totals, targets: target, localDate });
  return { points: lines.reduce((sum, line) => sum + line.points, 0), lines };
}

// Each result is a marginal comparison against the same day, never a fixed
// rating attached to a food. Included items compare the day with/without them.
export function foodScoreImpact({ logs, target, localDate, food, grams, slot, logId, replaceLogId }) {
  const included = logId != null;
  const existing = included ? logs.find(l => l.id === logId) : null;
  if (included && !existing) return { status: 'unavailable', reason: 'Log is no longer in this day.' };
  const nutrients = included ? existing.nutrients : computePortion(food, grams);
  if (!nutrients || nutrients.unknown || !Number.isFinite(nutrients.kcal) || !Number.isFinite(nutrients.proteinG))
    return { status: 'unavailable', reason: 'Nutrition is pending.' };
  if (logs.some(l => l.nutrients?.unknown)) return { status: 'unavailable', reason: 'Some nutrition in this day is pending.' };
  if (replaceLogId != null && !logs.some(l => l.id === replaceLogId)) return { status: 'unavailable', reason: 'Log is no longer in this day.' };
  const before = nutritionPoints(included ? logs.filter(l => l.id !== logId) : logs, target, localDate);
  const after = nutritionPoints(included ? logs : [...logs.filter(l => l.id !== replaceLogId), { slot, nutrients }], target, localDate);
  const keys = new Set([...before.lines, ...after.lines].map(l => l.key));
  const reasons = [...keys].map(key => ({ key,
    points: (after.lines.find(l => l.key === key)?.points || 0) - (before.lines.find(l => l.key === key)?.points || 0),
    label: after.lines.find(l => l.key === key)?.label || before.lines.find(l => l.key === key)?.label,
  })).filter(l => l.points !== 0);
  return { status: 'available', pointsDelta: after.points - before.points, beforePoints: before.points,
    afterPoints: after.points, reasons, grams: included ? Number(existing.grams) : grams,
    doctorPlanUsed: Boolean(target?.doctorPlan?.targetFields?.length), foodInstructions: target?.doctorPlan?.foodInstructions || null,
    basis: 'live_daily_nutrition_points', nonAdditive: true };
}
