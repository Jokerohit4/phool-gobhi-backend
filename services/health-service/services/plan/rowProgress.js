import { PrismaClient } from '@prisma/client';
import { isDueOn } from '../ledger/ledgerPlanService.js';
import { getDayTotals } from '../ledger/nutritionService.js';
import { currentNutritionTarget } from '../ledger/currentTarget.js';
import { isQualifyingSession } from '../journey/showedUpDays.js';
import { getOnLayerKeys } from './layerState.js';
import { JOURNEY, ALWAYS_ON_LAYER_KEYS, LAYER_OF_LAYER_KEY } from '../journey/journeyConfig.js';
import { POINTS, ROW_POINTS } from '../ledger/constants.js';

/**
 * Determines the "today" date the same way dayCloseService does.
 * @returns {string} YYYY-MM-DD in IST
 */
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Checks if a date is in the future relative to today.
 * @param {string} localDate - YYYY-MM-DD
 * @returns {boolean}
 */
function isFutureDate(localDate) {
  const today = todayIST();
  return localDate > today;
}

/**
 * Gets the display order index for a row kind.
 * Display order (Contracts): workout/rest, water, food, steps, sleep, supplements (by name), doctor (by createdAt), own (by createdAt)
 */
function getDisplayOrder(row) {
  const kindOrder = {
    workout: 0,
    rest: 0,
    water: 1,
    food: 2,
    steps: 3,
    sleep: 4,
    supplement: 5,
    doctor: 6,
    own: 7,
  };
  return kindOrder[row.kind] ?? 99;
}

/**
 * Builds a row object for the /plan/today response.
 * @param {object} item - PlanItem from database
 * @param {object} completion - Completion record if exists
 * @param {object} totals - Day totals from nutritionService
 * @param {object} target - NutritionTarget if exists
 * @param {string} localDate - The date being resolved
 * @param {boolean} hasQualifyingSession - Whether user had a qualifying workout session
 * @returns {object} Row object for the response
 */
function buildRow(item, completion, totals, target, localDate, hasQualifyingSession) {
  const isDone = !!completion;
  const how = completion?.how ?? null;
  let progress = isDone ? 1 : 0;
  let value = null;
  let targetValue = null;
  let unit = null;
  let action = 'tick';
  let points = 0;
  let earned = null;
  let supplementId = null;
  let templateId = null;
  let moves = null;
  let protein = null;

  switch (item.kind) {
    case 'workout':
      points = ROW_POINTS.workout;
      if (!isDone && hasQualifyingSession) {
        progress = 1;
      }
      action = isDone ? 'open_session' : 'start_session';
      templateId = item.templateId ?? null;
      // Moves would need to be fetched from template exercises
      break;
    case 'rest':
      points = ROW_POINTS.rest;
      progress = 1; // Rest is always done
      action = 'none';
      break;
    case 'habit':
      if (item.layerKey === 'water') {
        points = ROW_POINTS.habit;
        value = totals?.waterMl ?? 0;
        targetValue = target?.waterMl ?? 2500;
        unit = 'ml';
        action = 'log_water';
        if (!isDone) progress = Math.min(1, value / targetValue);
      } else {
        // Other habits (sleep is handled separately, but could be here too)
        points = ROW_POINTS.habit;
      }
      break;
    case 'steps':
      points = ROW_POINTS.habit;
      value = totals?.steps ?? 0;
      targetValue = item.targetValue ?? 6000;
      unit = 'steps';
      action = 'tick';
      if (!isDone) progress = Math.min(1, value / targetValue);
      break;
    case 'sleep':
      points = ROW_POINTS.habit;
      value = totals?.sleepMinutes ?? 0;
      targetValue = item.targetValue ?? 420;
      unit = 'min';
      action = 'tick';
      if (!isDone) progress = Math.min(1, value / targetValue);
      break;
    case 'supplement':
      points = ROW_POINTS.habit;
      supplementId = item.sourceRef ? Number(item.sourceRef.replace('supplement:', '')) : null;
      action = 'mark_supplement';
      break;
    case 'own':
      points = item.ownKind === 'workout' ? ROW_POINTS.workout : ROW_POINTS.habit;
      action = 'tick';
      break;
    case 'doctor_medication':
    case 'doctor_test':
    case 'doctor_appointment':
      points = ROW_POINTS.doctor;
      action = 'tick';
      break;
  }

  const row = {
    key: `item:${item.id}`,
    itemId: item.id,
    kind: item.kind === 'rest' ? 'rest' : item.kind,
    layerKey: item.layerKey,
    origin: item.origin,
    title: item.title,
    points,
    done: isDone,
    how,
    progress,
    value,
    target: targetValue,
    unit,
    action,
  };

  if (templateId !== null) row.templateId = templateId;
  if (moves !== null) row.moves = moves;
  if (supplementId !== null) row.supplementId = supplementId;
  if (protein !== null) row.protein = protein;

  return row;
}

/**
 * Builds the synthesized food row.
 * @param {object} totals - Day totals from nutritionService
 * @param {object} target - NutritionTarget if exists
 * @param {boolean} foodLayerOn - Whether food layer is on
 * @returns {object|null} Food row or null if food layer not on
 */
function buildFoodRow(totals, target, foodLayerOn) {
  if (!foodLayerOn) return null;

  const proteinTarget = target?.proteinG ?? 0;
  const calorieTarget = target?.kcal ?? 0;
  const proteinValue = totals?.proteinG ?? 0;
  const calorieValue = totals?.kcal ?? 0;
  const mealsLogged = totals?.mealSlotsCovered ?? 0;

  const possibleProtein = proteinTarget > 0 ? ROW_POINTS.foodProtein : 0;
  const possibleCalories = calorieTarget > 0 ? ROW_POINTS.foodCalories : 0;
  const possibleMeals = ROW_POINTS.foodMeals;
  const possible = possibleProtein + possibleCalories + possibleMeals;

  let earned = 0;
  if (proteinTarget > 0 && proteinValue / proteinTarget >= 0.9) earned += ROW_POINTS.foodProtein;
  if (calorieTarget > 0 && Math.abs(1 - calorieValue / calorieTarget) <= 0.1) earned += ROW_POINTS.foodCalories;
  if (mealsLogged >= 3) earned += ROW_POINTS.foodMeals;

  const done = earned === possible && possible > 0;

  return {
    key: 'food',
    itemId: null,
    kind: 'food',
    layerKey: 'food',
    origin: 'suggested',
    title: 'Food',
    points: possible,
    earned,
    done,
    how: null,
    progress: possible > 0 ? earned / possible : 0,
    value: calorieValue,
    target: calorieTarget,
    unit: 'kcal',
    protein: proteinTarget > 0 ? { value: proteinValue, target: proteinTarget } : null,
    action: 'log_food',
  };
}

/**
 * Calculates bonus points for the day.
 * @param {object} totals - Day totals
 * @param {boolean} hasQualifyingSession - Whether user had a qualifying workout session
 * @param {boolean} hasPlannedWorkout - Whether a workout was planned
 * @param {boolean} hasPlannedWorkoutDone - Whether the planned workout was done
 * @param {boolean} isRestDay - Whether today is a rest day
 * @returns {number} Bonus points
 */
function calculateBonus(totals, hasQualifyingSession, hasPlannedWorkout, hasPlannedWorkoutDone, isRestDay) {
  let bonus = 0;

  // Unplanned workout bonus (+8)
  // Qualifying session on a day with no workout row, or second qualifying session on a workout day
  // Max one +8 per day
  if (hasQualifyingSession) {
    if (!hasPlannedWorkout || (hasPlannedWorkout && !hasPlannedWorkoutDone)) {
      bonus += POINTS.unplannedWorkout; // 8
    }
  }

  // Micronutrient bonus (<= 10)
  if (totals && target) {
    // Note: target is not available here, this would need to be passed
    // For now, we'll calculate this in the main function where target is available
  }

  return bonus;
}

/**
 * Resolves one localDate into the full row list (the single "done" resolver
 * shared by todayService and the score engine).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{userId: number, localDate: string, onLayerKeys?: string[]}} options
 * @returns {Promise<{rows: object[], food: object|null, bonus: number, earned: number, target: number, counts: {done: number, total: number}, onLayerKeys: string[]}>}
 */
export async function resolveDay(prisma, { userId, localDate, onLayerKeys } = {}) {
  // Validate date
  if (!localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    localDate = todayIST();
  }

  // If future date, treat as today
  if (isFutureDate(localDate)) {
    localDate = todayIST();
  }

  // Get onLayerKeys if not provided
  if (!onLayerKeys) {
    onLayerKeys = await getOnLayerKeys(prisma, userId);
  }

  // Check if food layer is on
  const foodLayerOn = onLayerKeys.includes('food');

  // Get plan items due today
  const items = await prisma.planItem.findMany({
    where: { userId, active: true },
    include: {
      completions: { where: { localDate } },
    },
    orderBy: [{ kind: 'asc' }, { id: 'asc' }],
  });

  // Get food totals and target
  const [totals, target] = await Promise.all([
    getDayTotals(prisma, userId, localDate),
    currentNutritionTarget(prisma, userId),
  ]);

  // Check for qualifying workout session
  const sessions = await prisma.workoutSession.findMany({
    where: { userId, localDate, endedAt: { not: null } },
    select: { id: true, type: true, endedAt: true, startedAt: true, exercises: { select: { sets: { where: { completed: true }, select: { id: true } } } } },
  });

  const hasQualifyingSession = sessions.some((s) => isQualifyingSession(s));
  const hasPlannedWorkout = items.some((i) => i.kind === 'workout');
  const hasPlannedWorkoutDone = items.some((i) => i.kind === 'workout' && i.completions?.length > 0);
  const isRestDay = items.some((i) => i.kind === 'rest');

  // Build rows for each plan item
  const rows = [];
  let earned = 0;
  let totalRows = 0;
  let doneRows = 0;

  // Sort items by display order
  const sortedItems = [...items].sort((a, b) => getDisplayOrder(a) - getDisplayOrder(b));

  for (const item of sortedItems) {
    // Check if item is due today
    if (item.endsOn && localDate > item.endsOn) continue;
    if (!isDueOn(item, localDate, localDate)) continue;

    // Filter by onLayerKeys for suggested items
    if (item.origin === 'suggested' && item.layerKey && !onLayerKeys.includes(item.layerKey)) {
      continue;
    }
    // Medicine layer items only when medical_records consent granted
    if (item.layerKey === 'medicine' && !onLayerKeys.includes('medicine')) {
      continue;
    }

    const completion = item.completions?.[0] ?? null;
    const row = buildRow(item, completion, totals, target, localDate, hasQualifyingSession);
    rows.push(row);

    totalRows++;
    if (row.done) doneRows++;
    if (row.kind !== 'food' && row.done && row.points > 0) {
      earned += row.points;
    }
  }

  // Build food row
  const foodRow = buildFoodRow(totals, target, foodLayerOn);
  if (foodRow) {
    rows.push(foodRow);
    totalRows++;
    if (foodRow.done) doneRows++;
    earned += foodRow.earned ?? 0;
  }

  // Calculate target (sum of points for all due rows)
  const targetPoints = rows.reduce((sum, r) => sum + (r.points ?? 0), 0);

  // Calculate bonus
  let bonus = 0;
  // Unplanned workout bonus
  if (hasQualifyingSession && (!hasPlannedWorkout || (hasPlannedWorkout && !hasPlannedWorkoutDone))) {
    bonus += POINTS.unplannedWorkout; // 8
  }
  // Micronutrient bonus (max 10)
  if (target && totals) {
    let microPoints = 0;
    const micros = ['iron', 'magnesium', 'calcium', 'zinc'];
    for (const key of micros) {
      const t = target.micros?.[key];
      if (!t) continue;
      const got = totals[key];
      if (got !== undefined && got !== null && got / t >= 0.8) {
        microPoints += 2; // POINTS.microPerMet
      }
    }
    bonus += Math.min(microPoints, 10); // POINTS.microMaxPerDay
  }

  return {
    rows,
    food: foodRow,
    bonus,
    earned,
    target: targetPoints,
    counts: { done: doneRows, total: totalRows },
    onLayerKeys,
  };
}

export { todayIST, isFutureDate, getDisplayOrder, buildRow, buildFoodRow, calculateBonus };