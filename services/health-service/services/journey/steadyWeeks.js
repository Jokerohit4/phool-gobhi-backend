import { weekStartOf } from '../../utils/sessionDay.js';
/**
 * Compute steady weeks from a list of showed-up days.
 * A steady week = a Monday-start week with 2 or more distinct showed-up days.
 * Returns the count of steady weeks.
 */
export function countSteadyWeeks(showedUpDays) {
  if (!Array.isArray(showedUpDays) || showedUpDays.length === 0) return 0;

  // Group days by Monday-start week
  const weekMap = new Map();

  for (const dayStr of showedUpDays) {
    const mondayStr = weekStartOf(dayStr);

    if (!weekMap.has(mondayStr)) {
      weekMap.set(mondayStr, new Set());
    }
    weekMap.get(mondayStr).add(dayStr);
  }

  // Count weeks with 2+ distinct days
  let steadyWeeks = 0;
  for (const [, days] of weekMap) {
    if (days.size >= 2) steadyWeeks++;
  }

  return steadyWeeks;
}

/**
 * Get steady weeks with detail (which weeks, how many days each).
 * Useful for debugging and the journey summary.
 */
export function getSteadyWeeksDetail(showedUpDays) {
  if (!Array.isArray(showedUpDays) || showedUpDays.length === 0) return [];

  const weekMap = new Map();

  for (const dayStr of showedUpDays) {
    const mondayStr = weekStartOf(dayStr);

    if (!weekMap.has(mondayStr)) {
      weekMap.set(mondayStr, new Set());
    }
    weekMap.get(mondayStr).add(dayStr);
  }

  const result = [];
  for (const [mondayStr, days] of weekMap) {
    if (days.size >= 2) {
      result.push({
        weekStart: mondayStr,
        days: Array.from(days).sort(),
        dayCount: days.size,
      });
    }
  }

  // Sort by week start descending (newest first)
  result.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  return result;
}