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
import { getOnLayerKeys } from './layerState.js';
import { computeEarns } from '../ledger/scoreEngine.js';

// Row kinds the app renders for habit rows are named after the layer, not the
// generic PlanItem kind ('habit'). Row kinds for the other kinds are the
// PlanItem kind already.
const ROW_KIND_BY_LAYER = { water: 'water', steps: 'steps', sleep: 'sleep' };

export async function resolveDay(prisma, { userId, localDate, onLayerKeys } = {}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  onLayerKeys ??= await getOnLayerKeys(prisma, userId);

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
    getPlanForDate(prisma, { userId, localDate, today, onLayerKeys }),
    getDayTotals(prisma, userId, localDate),
    currentNutritionTarget(prisma, userId, localDate),
    prisma.workoutSession.findMany({
      where: { userId, localDate, endedAt: { not: null }, type: { not: null, notIn: ['rest'] } },
      select: { id: true, type: true, startedAt: true, endedAt: true, exercises: { select: { sets: { select: { id: true, completed: true } } } } },
    }),
    prisma.supplementLog.findMany({
      where: { userId, localDate },
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

  const activitySteps = activityRows.reduce((max, r) => Math.max(max, Number(r.steps) || 0), 0);
  const biometricSteps = biometricRows
    .filter((r) => r.metric === 'steps')
    .reduce((max, r) => Math.max(max, Number(r.value) || 0), 0);
  const stepsTarget = nutritionTarget?.stepsPerDay ?? DEFAULT_STEPS;
  const stepsLogged = Math.max(activitySteps, biometricSteps);

  const sleepTarget = nutritionTarget?.sleepMinutes ?? DEFAULT_SLEEP_MINUTES;
  const sleepLogged = biometricRows
    .filter((r) => r.metric === 'sleep_minutes')
    .reduce((max, r) => Math.max(max, Number(r.value) || 0), 0);

  const qualifyingSessions = sessions.filter(isQualifyingSession);
  // PlanItem stores the weekday schedule; the template lives on its slot.
  const prescription = planItems.some((i) => i.kind === 'workout' && i.origin !== 'user' && !i.templateId)
    ? await prisma.prescription.findUnique({ where: { userId } }) : null;
  const weekday = (new Date(`${localDate}T00:00:00Z`).getUTCDay() + 6) % 7;

  const layerFilter = new Set(onLayerKeys);
  const isOnLayer = (item) => layerFilter.has(item.layerKey);

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
    let automaticSatisfied = false;
    let how = manualHow;
    let value = null;
    let tgt = null;
    let unit = null;
    let action = 'tick';
    let templateId = null;
    let moves = null;
    let protein = null;

    const wireKind = item.origin === 'user' ? 'own'
      : item.origin === 'doctor' ? 'doctor'
      : item.layerKey === 'supplements' ? 'supplement'
      : item.kind === 'habit' ? (ROW_KIND_BY_LAYER[item.layerKey] || 'habit') : item.kind;
    const resolveKind = wireKind === 'doctor' ? item.kind
      : ['water', 'steps', 'sleep'].includes(wireKind) ? 'habit' : wireKind;
    switch (resolveKind) {
      case 'workout': {
        points = ROW_POINTS.workout;
        target += points;
        totalCount += 1;
        const sessionDone = qualifyingSessions.length > 0;
        automaticSatisfied = sessionDone;
        done = completed || sessionDone;
        if (done) {
          doneCount += 1;
          earned += points;
        }
        how = manualHow ?? autoHow(sessionDone);
        action = done ? 'open_session' : 'start_session';
        const slot = prescription?.workoutSlots?.find((s) => Number(s.weekday) === weekday);
        templateId = slot?.templateId ?? item.templateId ?? null;
        const template = templateId ? await prisma.workoutTemplate.findUnique({
          where: { id: templateId }, include: { exercises: true },
        }) : null;
        moves = template?.exercises?.length ?? null;
        progress = done ? 1 : 0;
        break;
      }
      case 'rest': {
        points = ROW_POINTS.rest;
        target += points;
        totalCount += 1;
        done = true;
        automaticSatisfied = true;
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
          const rowTarget = Number(item.targetValue ?? waterTarget);
          progress = rowTarget > 0 ? Math.min(1, waterLogged / rowTarget) : 0;
          automaticSatisfied = rowTarget > 0 && waterLogged >= rowTarget;
          done = completed || automaticSatisfied;
          how = manualHow ?? autoHow(automaticSatisfied);
          value = waterLogged;
          tgt = rowTarget;
          unit = 'ml';
          action = 'log_water';
        } else if (item.layerKey === 'steps') {
          const rowTarget = Number(item.targetValue ?? stepsTarget);
          progress = rowTarget > 0 ? Math.min(1, stepsLogged / rowTarget) : 0;
          automaticSatisfied = rowTarget > 0 && stepsLogged >= rowTarget;
          done = completed || automaticSatisfied;
          how = manualHow ?? autoHow(automaticSatisfied);
          value = stepsLogged;
          tgt = rowTarget;
          unit = 'steps';
          action = 'tick';
        } else if (item.layerKey === 'sleep') {
          const rowTarget = Number(item.targetValue ?? sleepTarget);
          progress = rowTarget > 0 ? Math.min(1, sleepLogged / rowTarget) : 0;
          automaticSatisfied = rowTarget > 0 && sleepLogged >= rowTarget;
          done = completed || automaticSatisfied;
          how = manualHow ?? autoHow(automaticSatisfied);
          value = sleepLogged;
          tgt = rowTarget;
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
        automaticSatisfied = suppDone;
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
        points = (item.ownKind ?? item.kind) === 'workout' ? ROW_POINTS.workout : ROW_POINTS.habit;
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
        continue;
    }

    const kind = wireKind;
    // A backfilled tick earns zero, but cannot erase credit already supplied
    // by an on-date log (or the always-honoured rest row).
    const late = completion?.late === true && !automaticSatisfied;
    if (done) progress = 1;
    if (done && late) earned -= points;

    rows.push({
      key: `item:${item.id}`,
      id: item.id,
      itemId: item.id,
      kind,
      ...(kind === 'own' ? { ownKind: item.ownKind ?? item.kind } : {}),
      layerKey: item.layerKey,
      origin: item.origin,
      title: item.title,
      points,
      earned: done && !late ? points : 0,
      late,
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
  const scoringTarget = layerFilter.has('food') ? nutritionTarget : null;
  const scoringTotals = {
    ...foodResult.totals,
    hasAnyFood: foodResult.logCount > 0,
    mealSlotsCovered: ['breakfast', 'lunch', 'dinner'].filter((slot) => foodResult.bySlot[slot]?.count > 0).length,
  };
  for (const key of Object.keys(scoringTarget?.micros ?? {})) {
    scoringTotals[key] = foodResult.logs.reduce((sum, log) =>
      sum + (log.nutrients?.unknown ? 0 : Number(log.nutrients?.[key]) || 0), 0);
  }
  const foodLines = computeEarns({ targets: scoringTarget, totals: scoringTotals, localDate });

  if (layerFilter.has('food')) {
    if (nutritionTarget) {
      const hasProteinTarget = Number(nutritionTarget.proteinG) > 0;
      const hasCalorieTarget = Number(nutritionTarget.kcal) > 0;

      if (hasProteinTarget) foodPossible += ROW_POINTS.foodProtein;
      if (hasCalorieTarget) foodPossible += ROW_POINTS.foodCalories;
      foodPossible += ROW_POINTS.foodMeals;

      foodEarned = foodLines.filter((l) => l.key !== 'micros_met').reduce((sum, l) => sum + l.points, 0);
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
      rows.push(food);
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
  bonus += foodLines.find((l) => l.key === 'micros_met')?.points ?? 0;

  // Display order: workout/rest, water, food, steps, sleep, supplements,
  // doctor, own.
  const order = ['workout', 'rest', 'water', 'food', 'steps', 'sleep', 'supplement', 'doctor', 'own'];
  rows.sort((a, b) => {
    const ia = order.indexOf(a.kind);
    const ib = order.indexOf(b.kind);
    if (ia !== ib) return ia - ib;
    if (a.kind === 'supplement') {
      return (a.title || '').localeCompare(b.title || '');
    }
    if (a.kind === 'doctor' || a.kind === 'own') {
      const created = (id) => new Date(planItems.find((i) => i.id === id)?.createdAt ?? 0).getTime();
      return created(a.itemId) - created(b.itemId) || a.itemId - b.itemId;
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
    nutritionTarget: scoringTarget,
    totals: scoringTotals,
    unplannedWorkout,
    finishedSessions: sessions.length,
    onLayerKeys: onLayerKeys || [],
  };
}
