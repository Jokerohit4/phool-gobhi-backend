import { POINTS } from './constants.js';

export function foodTargetProgress(totals, targets) {
  const proteinRatio = targets.proteinG > 0 ? (totals.proteinG || 0) / targets.proteinG : null;
  const kcalRatio = targets.kcal > 0 ? (totals.kcal || 0) / targets.kcal : null;
  return {
    proteinRatio,
    kcalRatio,
    proteinMet: proteinRatio !== null && proteinRatio >= 0.9,
    caloriesMet: kcalRatio !== null && Math.abs(1 - kcalRatio) <= POINTS.caloriesOnTargetRatio,
  };
}
