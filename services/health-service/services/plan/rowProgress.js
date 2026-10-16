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
import { ROW_POINTS, POINTS, DEFAULT_SLEEP_MINUTES } from '../ledger/constants.js';
import { DEFAULT_STEPS } from '../journey/journeyConfig.js';

// Row kinds the app renders for habit rows are named after the layer, not the
// generic PlanItem kind ('habit'). Row kinds for the other kinds are the
// PlanItem kind already.
const ROW_KIND_BY_LAYER = { water: 'water', steps: 'steps', sleep: 'sleep' };

export async function resolveDay(prisma, { userId, localDate, onLayerKeys } = {}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const [
    planResult,
    foodResult,
    nutritionTarget,
    sessions,
    supplementLogs,
    waterLogs,
    activityRows,
    biometricRows,
  ] = await Promise.all([
    getPlanForDate(prisma, { userId, localDate, today }),
    getDayTotals(prisma, userId, localDate),
    currentNutritionTarget(prisma, userId),
    prisma.workoutSession.findMany({
      where: { userId, localDate, endedAt: { not: null }, type: { not: null, not: 'rest' } },
      select: { id: true, type: true, startedAt: true, endedAt: true, exercises: { select: { sets: { where: { completed: true }, select: { id: true } } } } },
    }),
    prisma.supplementLog.findMany({
      where: { userId, localDate, taken: true },
      select: { scheduleId: true },
    }),
    prisma.waterLog.findMany({
      where: { userId, localDate },
      select: { ml: true },
    }),
    prisma.dailyActivityMetric.findMany({
      where: { userId, date: localDate },
      select: { steps: true },
    }),
    prisma.biometricEntry.findMany({
      where: { userId, localDate },
      select: { metric: true, value: true },
    }),
  ]);

  const planItems = planResult.items;
  // getPlanForDate returns every due row with its completion for the date
  // (`completion: {how, late} | null`, how = 'tick' | 'auto'); it no longer
  // hands back the raw `completions` array.
  const completions = planItems
    .filter((item) => item.completion)
    .map((item) => ({ ...item.completion, planItemId: item.id }));

  const completedItemIds = new Set(completions.map((c) => c.planItemId));
  const takenSupplementIds = new Set(supplementLogs.map((l) => Number(l.scheduleId)));

  // Water comes from WaterLog; steps from DailyActivityMetric (device) or a
  // manual BiometricEntry; sleep from a BiometricEntry.
  const waterTarget = nutritionTarget?.waterMl ?? 2500;
  const waterLogged = waterLogs.reduce((sum, r) => sum + (Number(r.ml) || 0), 0);
  const waterDone = waterLogged >= waterTarget;

  const activitySteps = activityRows.reduce((max, r) => Math.max(max, Number(r.steps) || 0), 0);
  const biometricSteps = biometricRows
    .filter((r) => r.metric === 'steps')
    .reduce((max, r) => Math.max(max, Number(r.value) || 0), 0);
  const stepsTarget = nutritionTarget?.stepsPerDay ?? DEFAULT_STEPS;
  const stepsLogged = Math.max(activitySteps, biometricSteps);
  const stepsDone = stepsLogged >= stepsTarget;

  const sleepTarget = nutritionTarget?.sleepMinutes ?? DEFAULT_SLEEP_MINUTES;
  const sleepLogged = biometricRows
    .filter((r) => r.metric === 'sleep_minutes')
    .reduce((max, r) => Math.max(max, Number(r.value) || 0), 0);
  const sleepDone = sleepLogged >= sleepTarget;

  const qualifyingSessions = sessions.filter(isQualifyingSession);

  // If the caller passed onLayerKeys it has already resolved the on layers;
  // don't recompute. When it is absent, treat every row as on.
  const layerFilter = Array.isArray(onLayerKeys) ? new Set(onLayerKeys) : null;
  // A null layerKey means the item belongs to no layer (the schema allows it
  // for anything created before the journey existed, or that simply has no
  // layer). The layer filter decides which *layers* are on, so it cannot
  // exclude a row that has no layer - those are always part of the day.
  const isOnLayer = (item) => !layerFilter || !item.layerKey || layerFilter.has(item.layerKey);

  const rows = [];
  let earned = 0;
  let target = 0;
  let doneCount = 0;
  let totalCount = 0;

  for (const item of planItems) {
    if (!isOnLayer(item)) continue;

    const completed = completedItemIds.has(item.id);
    const completion = completions.find((c) => c.planItemId === item.id);
    const manualHow = completed ? (completion?.how === 'auto' ? 'auto' : 'tick') : null;
    const autoHow = (autoDone) => (autoDone ? 'auto' : null);

    let points = 0;
    let progress = 0;
    let done = false;
    let how = manualHow;
    let value = null;
    let tgt = null;
    let unit = null;
    let action = 'tick';
    let templateId = null;
    let moves = null;
    let protein = null;

    switch (item.kind) {
      case 'workout': {
        points = ROW_POINTS.workout;
        target += points;
        totalCount += 1;
        const sessionDone = qualifyingSessions.length > 0;
        done = completed || sessionDone;
        if (done) {
          doneCount += 1;
          earned += points;
        }
        how = manualHow ?? autoHow(sessionDone);
        action = done ? 'open_session' : 'start_session';
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
        how = manualHow ?? 'auto';
        action = 'none';
        progress = 1;
        break;
      }
      case 'habit': {
        points = ROW_POINTS.habit;
        target += points;
        totalCount += 1;
        if (item.layerKey === 'water') {
          progress = waterTarget > 0 ? Math.min(1, waterLogged / waterTarget) : 0;
          done = completed || waterDone;
          how = manualHow ?? autoHow(waterDone);
          value = waterLogged;
          tgt = waterTarget;
          unit = 'ml';
          action = 'log_water';
        } else if (item.layerKey === 'steps') {
          progress = stepsTarget > 0 ? Math.min(1, stepsLogged / stepsTarget) : 0;
          done = completed || stepsDone;
          how = manualHow ?? autoHow(stepsDone);
          value = stepsLogged;
          tgt = stepsTarget;
          unit = 'steps';
          action = 'tick';
        } else if (item.layerKey === 'sleep') {
          progress = sleepTarget > 0 ? Math.min(1, sleepLogged / sleepTarget) : 0;
          done = completed || sleepDone;
          how = manualHow ?? autoHow(sleepDone);
          value = sleepLogged;
          tgt = sleepTarget;
          unit = 'min';
          action = 'tick';
        } else {
          done = completed;
          progress = done ? 1 : 0;
        }
        if (done) {
          doneCount += 1;
          earned += points;
        }
        break;
      }
      case 'supplement': {
        points = ROW_POINTS.habit;
        target += points;
        totalCount += 1;
        const scheduleId = Number(String(item.sourceRef || '').replace('supplement:', ''));
        const suppDone = takenSupplementIds.has(scheduleId);
        done = suppDone || completed;
        how = manualHow ?? autoHow(suppDone);
        if (done) {
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
        done = completed;
        if (done) {
          doneCount += 1;
          earned += points;
        }
        progress = done ? 1 : 0;
        break;
      }
      case 'doctor_medication':
      case 'doctor_test':
      case 'doctor_appointment': {
        points = ROW_POINTS.doctor;
        target += points;
        totalCount += 1;
        done = completed;
        if (done) {
          doneCount += 1;
          earned += points;
        }
        progress = done ? 1 : 0;
        break;
      }
      case 'nutrition': {
        // Legacy nutrition items - not used in one-plan (food is synthesised)
        continue;
      }
      default:
        break;
    }

    const kind = item.kind === 'habit' ? (ROW_KIND_BY_LAYER[item.layerKey] || 'habit') : item.kind;

    rows.push({
      key: `item:${item.id}`,
      id: item.id,
      itemId: item.id,
      kind,
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

  if (layerFilter ? layerFilter.has('food') : true) {
    if (nutritionTarget) {
      const hasProteinTarget = Number(nutritionTarget.proteinG) > 0;
      const hasCalorieTarget = Number(nutritionTarget.kcal) > 0;

      if (hasProteinTarget) foodPossible += ROW_POINTS.foodProtein;
      if (hasCalorieTarget) foodPossible += ROW_POINTS.foodCalories;
      foodPossible += ROW_POINTS.foodMeals;

      const proteinRatio = hasProteinTarget
        ? (foodResult.totals.proteinG || 0) / nutritionTarget.proteinG
        : null;
      const kcalRatio = hasCalorieTarget
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
        id: null,
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
  }

  // Bonus (shown above the target, never counted in it):
  //   unplanned workout +8 (a qualifying session on a day with no workout row,
  //   or a second qualifying session on a workout day; max one per day)
  //   + micronutrient points (<= 10).
  let bonus = 0;
  const hasWorkoutRow = rows.some((r) => r.kind === 'workout');
  const unplannedWorkout =
    qualifyingSessions.length > 0 && (!hasWorkoutRow || qualifyingSessions.length > 1);
  if (unplannedWorkout) bonus += POINTS.unplannedWorkout;
  bonus += calculateMicronutrientPoints(nutritionTarget, foodResult.logs);

  // Display order: workout/rest, water, food, steps, sleep, supplements,
  // doctor, own.
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
    // Finished non-rest sessions for the day, before the qualifying filter.
    // `bonus` above only pays a *qualifying* session; the engine's extra-workout
    // line pays any finished one, so the caller needs the unfiltered count.
    finishedSessions: sessions.length,
    onLayerKeys: onLayerKeys || [],
  };
}

// Micronutrients are read from the raw food-log snapshots (the totals only
// carry the macro/4-mineral snapshot fields). Every key the target tracks is
// scored, 2 points each over the met ratio, capped at 10 a day.
function calculateMicronutrientPoints(targets, logs) {
  if (!targets?.micros) return 0;

  const got = {};
  for (const log of logs || []) {
    const nutrients = log?.nutrients || {};
    for (const [key, raw] of Object.entries(nutrients)) {
      const value = Number(raw);
      if (Number.isFinite(value)) got[key] = (got[key] || 0) + value;
    }
  }

  let points = 0;
  for (const key of Object.keys(targets.micros)) {
    const target = Number(targets.micros[key]);
    if (!target) continue;
    if ((got[key] || 0) / target >= 0.8) points += 2;
  }
  return Math.min(points, 10);
}
