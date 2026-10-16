/**
 * Resolves one localDate into the full row list (the single "done" resolver
 * shared by todayService and the score engine).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{userId: number, localDate: string, onLayerKeys?: string[]}} options
 * @returns {Promise<{rows: object[], food: object|null, bonus: number, earned: number, target: number, counts: {done: number, total: number}, onLayerKeys: string[]}>}
 */
import { getPlanForDate } from '../ledger/ledgerPlanService.js';
import { getDayTotals } from '../ledger/nutritionService.js';
import { currentNutritionTarget } from '../ledger/currentTarget.js';
import { isQualifyingSession } from '../journey/showedUpDays.js';
import { ROW_POINTS, DEFAULT_SLEEP_MINUTES } from '../ledger/constants.js';
import { DEFAULT_STEPS } from '../journey/journeyConfig.js';

export async function resolveDay(prisma, { userId, localDate, onLayerKeys } = {}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const [
    planResult,
    foodResult,
    nutritionTarget,
    sessions,
    supplementLogs,
  ] = await Promise.all([
    getPlanForDate(prisma, { userId, localDate, today }),
    getDayTotals(prisma, userId, localDate),
    currentNutritionTarget(prisma, userId),
    prisma.workoutSession.findMany({
      where: { userId, localDate, endedAt: { not: null }, type: { not: null, not: 'rest' } },
      select: { id: true, startedAt: true, endedAt: true, exercises: { select: { sets: { where: { completed: true }, select: { id: true } } } } },
    }),
    prisma.supplementLog.findMany({
      where: { userId, localDate, taken: true },
      select: { scheduleId: true },
    }),
  ]);

  const planItems = planResult.items;
  const completions = planItems.flatMap((item) =>
    (item.completions || []).map((c) => ({ ...c, planItemId: item.id }))
  );

  const completedItemIds = new Set(completions.map((c) => c.planItemId));
  const takenSupplementIds = new Set(supplementLogs.map((l) => l.scheduleId));

  const waterTarget = nutritionTarget?.waterMl ?? 2500;
  const waterLogged = foodResult.totals.waterMl || 0;
  const waterDone = waterLogged >= waterTarget;

  const stepsTarget = nutritionTarget?.stepsPerDay ?? DEFAULT_STEPS;
  const stepsLogged = Math.max(
    foodResult.bySlot?.steps?.total || 0,
    foodResult.totals.steps || 0
  );
  const stepsDone = stepsLogged >= stepsTarget;

  const sleepTarget = nutritionTarget?.sleepMinutes ?? DEFAULT_SLEEP_MINUTES;
  const sleepLogged = foodResult.totals.sleepMinutes || 0;
  const sleepDone = sleepLogged >= sleepTarget;

  const qualifyingSessions = sessions.filter(isQualifyingSession);
  const hasPlannedWorkout = planItems.some((i) => i.kind === 'workout');
  const hasPlannedWorkoutDone = planItems.some(
    (i) => i.kind === 'workout' && completedItemIds.has(i.id)
  );
  const unplannedWorkout = qualifyingSessions.length > 0 && !hasPlannedWorkoutDone;

  const rows = [];
  let earned = 0;
  let target = 0;
  let doneCount = 0;
  let totalCount = 0;

  const restItem = planItems.find((i) => i.kind === 'rest');

  for (const item of planItems) {
    const isDue = item.kind === 'rest' ? restItem === item : true;

    if (!isDue) continue;

    const completed = completedItemIds.has(item.id);
    const completion = completions.find((c) => c.planItemId === item.id);
    const how = completed ? (completion?.how === 'auto' ? 'auto' : 'tick') : null;

    let points = 0;
    let progress = 0;
    let done = false;
    let value = null;
    let tgt = null;
    let unit = null;
    let action = 'tick';
    let templateId = null;
    let moves = null;
    let protein = null;
    let earnedFood = null;
    let possibleFood = null;

    switch (item.kind) {
      case 'workout': {
        points = ROW_POINTS.workout;
        target += points;
        totalCount += 1;
        if (completed) {
          done = true;
          doneCount += 1;
          earned += points;
        }
        action = completed ? 'open_session' : 'start_session';
        const slot = await prisma.workoutTemplate.findUnique({ where: { id: item.templateId } });
        templateId = item.templateId;
        moves = slot?.moves ?? null;
        progress = done ? 1 : 0;
        break;
      }
      case 'rest': {
        points = ROW_POINTS.rest;
        target += points;
        totalCount += 1;
        done = true;
        doneCount += 1;
        earned += points;
        action = 'none';
        progress = 1;
        break;
      }
      case 'habit': {
        if (item.layerKey === 'water') {
          points = ROW_POINTS.habit;
          target += points;
          totalCount += 1;
          progress = Math.min(1, waterLogged / waterTarget);
          if (waterDone) {
            done = true;
            doneCount += 1;
            earned += points;
          }
          value = waterLogged;
          tgt = waterTarget;
          unit = 'ml';
          action = 'log_water';
        } else if (item.layerKey === 'steps') {
          points = ROW_POINTS.habit;
          target += points;
          totalCount += 1;
          progress = Math.min(1, stepsLogged / stepsTarget);
          if (stepsDone) {
            done = true;
            doneCount += 1;
            earned += points;
          }
          value = stepsLogged;
          tgt = stepsTarget;
          unit = 'steps';
          action = 'tick';
        } else if (item.layerKey === 'sleep') {
          points = ROW_POINTS.habit;
          target += points;
          totalCount += 1;
          progress = Math.min(1, sleepLogged / sleepTarget);
          if (sleepDone) {
            done = true;
            doneCount += 1;
            earned += points;
          }
          value = sleepLogged;
          tgt = sleepTarget;
          unit = 'min';
          action = 'tick';
        } else {
          points = ROW_POINTS.habit;
          target += points;
          totalCount += 1;
          if (completed) {
            done = true;
            doneCount += 1;
            earned += points;
          }
          progress = done ? 1 : 0;
        }
        break;
      }
      case 'supplement': {
        points = ROW_POINTS.habit;
        target += points;
        totalCount += 1;
        const suppDone = takenSupplementIds.has(item.sourceRef?.replace('supplement:', ''));
        if (suppDone || completed) {
          done = true;
          doneCount += 1;
          earned += points;
        }
        action = 'mark_supplement';
        progress = done ? 1 : 0;
        break;
      }
      case 'own': {
        points = item.ownKind === 'workout' ? ROW_POINTS.workout : ROW_POINTS.habit;
        target += points;
        totalCount += 1;
        if (completed) {
          done = true;
          doneCount += 1;
          earned += points;
        }
        progress = done ? 1 : 0;
        break;
      }
      case 'doctor_medication':
      case 'doctor_test': {
        points = ROW_POINTS.doctor;
        target += points;
        totalCount += 1;
        if (completed) {
          done = true;
          doneCount += 1;
          earned += points;
        }
        progress = done ? 1 : 0;
        break;
      }
      case 'doctor_appointment': {
        points = ROW_POINTS.doctor;
        target += points;
        totalCount += 1;
        if (completed) {
          done = true;
          doneCount += 1;
          earned += points;
        }
        progress = done ? 1 : 0;
        break;
      }
      case 'nutrition': {
        // Legacy nutrition items - not used in one-plan (food is synthesised)
        break;
      }
    }

    rows.push({
      key: `item:${item.id}`,
      itemId: item.id,
      kind: item.kind,
      layerKey: item.layerKey,
      origin: item.origin,
      title: item.title,
      points,
      done,
      how,
      progress,
      value,
      target: tgt,
      unit,
      action,
      templateId,
      moves,
      protein,
    });
  }

  // Food row (synthesised)
  let food = null;
  let foodPossible = 0;
  let foodEarned = 0;

  if (onLayerKeys?.includes('food') && nutritionTarget) {
    const hasProteinTarget = nutritionTarget.proteinG > 0;
    const hasCalorieTarget = nutritionTarget.kcal > 0;

    if (hasProteinTarget) foodPossible += ROW_POINTS.foodProtein;
    if (hasCalorieTarget) foodPossible += ROW_POINTS.foodCalories;
    foodPossible += ROW_POINTS.foodMeals;

    const proteinRatio = nutritionTarget.proteinG > 0
      ? (foodResult.totals.proteinG || 0) / nutritionTarget.proteinG
      : null;
    const kcalRatio = nutritionTarget.kcal > 0
      ? (foodResult.totals.kcal || 0) / nutritionTarget.kcal
      : null;
    const mealsLogged = foodResult.logCount || 0;

    let proteinEarned = 0;
    let kcalEarned = 0;
    let mealsEarned = 0;

    if (hasProteinTarget && proteinRatio !== null && proteinRatio >= 0.9) {
      proteinEarned = ROW_POINTS.foodProtein;
    }
    if (hasCalorieTarget && kcalRatio !== null && Math.abs(1 - kcalRatio) <= 0.1) {
      kcalEarned = ROW_POINTS.foodCalories;
    }
    if (mealsLogged >= 3) {
      mealsEarned = ROW_POINTS.foodMeals;
    }

    foodEarned = proteinEarned + kcalEarned + mealsEarned;
    earned += foodEarned;

    food = {
      key: 'food',
      itemId: null,
      kind: 'food',
      layerKey: 'food',
      origin: 'suggested',
      title: 'Food',
      points: foodPossible,
      earned: foodEarned,
      done: foodEarned === foodPossible && foodPossible > 0,
      how: null,
      progress: foodPossible > 0 ? foodEarned / foodPossible : 0,
      value: foodResult.totals.kcal || 0,
      target: nutritionTarget.kcal || 0,
      unit: 'kcal',
      protein: {
        value: foodResult.totals.proteinG || 0,
        target: nutritionTarget.proteinG || 0,
      },
      action: 'log_food',
    };

    totalCount += 1;
    if (food.done) doneCount += 1;
    target += foodPossible;
  }

  // Bonus
  let bonus = 0;
  const micronutrientPoints = calculateMicronutrientPoints(nutritionTarget, foodResult.totals);
  bonus += micronutrientPoints;
  if (unplannedWorkout) {
    bonus += ROW_POINTS.unplannedWorkout;
  }

  // Display order: workout/rest, water, food, steps, sleep, supplements, doctor, own
  const order = ['workout', 'rest', 'water', 'food', 'steps', 'sleep', 'supplement', 'doctor_medication', 'doctor_test', 'doctor_appointment', 'own'];
  rows.sort((a, b) => {
    const ia = order.indexOf(a.kind);
    const ib = order.indexOf(b.kind);
    if (ia !== ib) return ia - ib;
    if (a.kind === 'supplement' || a.kind === 'doctor_medication' || a.kind === 'doctor_test' || a.kind === 'doctor_appointment' || a.kind === 'own') {
      return (a.title || '').localeCompare(b.title || '');
    }
    return 0;
  });

  return {
    rows,
    food,
    bonus,
    earned,
    target,
    counts: { done: doneCount, total: totalCount },
    onLayerKeys: onLayerKeys || [],
  };
}

function calculateMicronutrientPoints(targets, totals) {
  const MICROS_TRACKED = ['iron', 'magnesium', 'calcium', 'zinc'];
  let points = 0;
  if (!targets?.micros) return 0;
  for (const key of MICROS_TRACKED) {
    const target = targets.micros[key];
    if (!target) continue;
    const got = totals[key];
    if (got !== undefined && got !== null && got / target >= 0.8) {
      points += 2;
    }
  }
  return Math.min(points, 10);
}