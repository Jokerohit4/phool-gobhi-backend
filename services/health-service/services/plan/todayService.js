import { PrismaClient } from '@prisma/client';
import { resolveDay } from './rowProgress.js';
import { getLayers, getOnLayerKeys } from './layerState.js';
import { getJourney, getUnlockedLayerKeys } from '../journey/journeyService.js';
import { previousClose } from '../ledger/scoreService.js';
import { isFeatureEnabled } from '../../middleware/requireFeatureFlag.js';
import { listTemplatesService } from '../templateService.js';
import { track } from '../../utils/analytics.js';

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
 * Gets pause state for a user.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {string} localDate
 * @returns {Promise<{paused: boolean, pausedUntil: string|null}>}
 */
async function getPauseState(prisma, userId, localDate) {
  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: { pausedFrom: true, pausedUntil: true },
  });
  if (!goal?.pausedFrom || !goal?.pausedUntil) {
    return { paused: false, pausedUntil: null };
  }
  const paused = localDate >= goal.pausedFrom && localDate <= goal.pausedUntil;
  return { paused, pausedUntil: goal.pausedUntil };
}

/**
 * Builds the Monday-start week array for the response.
 * @param {string[]} showedUpDays - Array of YYYY-MM-DD dates (newest first from getShowedUpDays)
 * @param {string} today - Today's date
 * @returns {object[]} Week array with 7 entries Mon-Sun
 */
function buildWeek(showedUpDays, today) {
  // Calendar arithmetic on a date-only UTC anchor, independent of host zone.
  const todayDate = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = todayDate.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(todayDate);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);

  const showedUpSet = new Set(showedUpDays);
  const week = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    const dayStr = day.toISOString().slice(0, 10);
    week.push({
      localDate: dayStr,
      showedUp: showedUpSet.has(dayStr),
      isToday: dayStr === today,
    });
  }
  return week;
}

/**
 * Gets the session for today and tomorrow from the workout slots.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {string} today
 * @returns {Promise<{today: object|null, tomorrow: object|null}>}
 */
async function getSessions(prisma, userId, today) {
  const prescription = await prisma.prescription.findUnique({ where: { userId } });
  const slots = prescription?.workoutSlots ?? [];
  if (!slots.length) return { today: null, tomorrow: null };

  const todayDate = new Date(`${today}T00:00:00Z`);
  const todayWeekday = todayDate.getUTCDay(); // 0 = Sunday
  const todayISOWeekday = todayWeekday === 0 ? 6 : todayWeekday - 1; // 0 = Monday

  const tomorrowDate = new Date(todayDate);
  tomorrowDate.setUTCDate(todayDate.getUTCDate() + 1);
  const tomorrowWeekday = tomorrowDate.getUTCDay();
  const tomorrowISOWeekday = tomorrowWeekday === 0 ? 6 : tomorrowWeekday - 1;

  const todaySlot = slots.find((s) => Number(s.weekday) === todayISOWeekday);
  const tomorrowSlot = slots.find((s) => Number(s.weekday) === tomorrowISOWeekday);

  const formatSession = async (slot) => {
    if (!slot) return null;
    const template = slot.templateId ? await prisma.workoutTemplate.findUnique({
      where: { id: slot.templateId }, include: { exercises: true },
    }) : null;
    return {
      templateId: slot.templateId ?? null,
      title: slot.title ?? template?.name ?? 'Workout',
      moves: template?.exercises?.length ?? null,
      done: false,
    };
  };

  const [todaySession, tomorrowSession] = await Promise.all([formatSession(todaySlot), formatSession(tomorrowSlot)]);
  return {
    today: todaySession,
    tomorrow: tomorrowSession,
  };
}

/**
 * Builds the GET /plan/today payload.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{localDate?: string}} [options] optional and ignored if in the future
 * @returns {Promise<object>} the /plan/today response body
 */
export async function buildToday(prisma, userId, { localDate } = {}) {
  const startTime = Date.now();

  // Determine the date
  let resolvedDate = localDate;
  if (!resolvedDate || !/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate) || isFutureDate(resolvedDate)) {
    resolvedDate = todayIST();
  }

  // Check coach basic consent first
  const coachConsent = await prisma.coachConsent.findUnique({ where: { userId } });
  if (!coachConsent || coachConsent.revokedAt || !coachConsent.scopes?.includes('basic')) {
    return {
      state: 'no_plan',
      reason: 'no_consent',
    };
  }

  // Get journey (exactly once - it syncs unlocks and rebuilds if needed)
  const journey = await getJourney(userId);
  if (!journey) {
    return {
      state: 'no_plan',
      reason: 'no_journey',
    };
  }

  // Load the journey once, then pass its on layers into the resolver.
  const [layers, onLayerKeys, scoreOpen, pauseState] = await Promise.all([
    getLayers(prisma, userId, { journey }),
    getOnLayerKeys(prisma, userId, { journey }),
    previousClose(prisma, { userId, localDate: resolvedDate }),
    getPauseState(prisma, userId, resolvedDate),
  ]);
  const dayResolution = await resolveDay(prisma, { userId, localDate: resolvedDate, onLayerKeys });
  const showedUpDays = journey.showedUpDates ?? [];

  // Re-extract resolved values from dayResolution
  const { rows, bonus, earned, target, counts } = dayResolution;

  // Check easy start
  const easyStartUntil = journey.easyStartUntil ? todayIST() <= journey.easyStartUntil ? journey.easyStartUntil : null : null;
  const noMisses = easyStartUntil !== null || journey.easeBack === true;

  // Get session info
  const sessions = await getSessions(prisma, userId, resolvedDate);

  // Determine if today's workout is done
  const todayWorkoutRow = rows.find((r) => r.kind === 'workout');
  if (sessions.today && todayWorkoutRow) {
    sessions.today.done = todayWorkoutRow.done;
  }
  if (sessions.tomorrow && sessions.tomorrow.title === 'Rest day') {
    sessions.tomorrow = null;
  }

  // Build week
  const week = buildWeek(showedUpDays, resolvedDate);

  // Build journey summary
  const journeySummary = {
    showedUpDays: showedUpDays.length,
    steadyWeeks: journey.steadyWeeks,
    easeBack: journey.easeBack,
  };

  const liveScore = scoreOpen + earned + bonus;

  const payload = {
    state: 'active',
    localDate: resolvedDate,
    paused: pauseState.paused,
    pausedUntil: pauseState.pausedUntil,
    easyStartUntil: easyStartUntil,
    noMisses,
    points: pauseState.paused ? null : { earned, target, bonus },
    counts,
    score: pauseState.paused ? { open: scoreOpen, live: scoreOpen } : { open: scoreOpen, live: liveScore },
    rows,
    session: sessions,
    layers,
    week,
    journey: journeySummary,
  };

  // Log duration
  const duration = Date.now() - startTime;
  if (duration > 300) {
    console.warn(`[todayService] buildToday took ${duration}ms for user ${userId}`);
  }

  return payload;
}

/**
 * Builds the GET /plan payload (settings, bounds, slots, items, layers, templates).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @returns {Promise<object>} the /plan response body
 */
export async function buildPlanDefinition(prisma, userId) {
  // Check coach basic consent
  const coachConsent = await prisma.coachConsent.findUnique({ where: { userId } });
  if (!coachConsent || coachConsent.revokedAt || !coachConsent.scopes?.includes('basic')) {
    return {
      state: 'no_plan',
      reason: 'no_consent',
    };
  }

  // Get journey
  const journey = await getJourney(userId);
  if (!journey) {
    return {
      state: 'no_plan',
      reason: 'no_journey',
    };
  }

  // Load data in parallel
  const [prescription, weeklyGoal, healthGoal, target, onLayerKeys, layers, templates] = await Promise.all([
    prisma.prescription.findUnique({ where: { userId } }),
    prisma.weeklyGoal.findUnique({ where: { userId } }),
    prisma.healthGoal.findUnique({ where: { userId } }),
    prisma.nutritionTarget.findFirst({ where: { userId }, orderBy: { effectiveFrom: 'desc' } }),
    getOnLayerKeys(prisma, userId, { journey }),
    getLayers(prisma, userId, { journey }),
    listTemplatesService(userId),
  ]);

  // Build settings
  const settings = {
    kcal: target ? Number(target.kcal) : null,
    stepsPerDay: prescription?.stepsPerDay ?? 6000,
    sleepMinutes: prescription?.sleepMinutes ?? 420,
    sessionsPerWeek: weeklyGoal?.sessionsPerWeek ?? 3,
  };

  // Build bounds (from prescriptionService)
  const bounds = {
    kcal: { min: 1200, max: 4500, step: 50 },
    stepsPerDay: { min: 2000, max: 25000, step: 500 },
    sleepMinutes: { min: 300, max: 540, step: 15 },
    sessionsPerWeek: { min: 1, max: 14, step: 1 },
  };

  // Build slots
  const slots = (prescription?.workoutSlots ?? []).map((slot) => ({
    weekday: Number(slot.weekday),
    templateId: slot.templateId ?? null,
    title: slot.title ?? '',
    level: slot.level ?? null,
    moves: slot.moves ?? null,
  }));

  // Build items (only user + doctor rows)
  const items = await prisma.planItem.findMany({
    where: { userId, active: true, origin: { in: ['user', 'doctor'] } },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  });

  const formattedItems = items.map((item) => ({
    itemId: item.id,
    kind: item.kind,
    ownKind: item.ownKind ?? null,
    layerKey: item.layerKey,
    origin: item.origin,
    title: item.title,
    schedule: item.schedule,
    targetValue: item.targetValue,
    prescribedBy: item.prescribedBy,
    prescribedNote: item.prescribedNote,
    endsOn: item.endsOn,
  }));

  // Format templates for the editor (system + own)
  const formattedTemplates = templates.map((t) => ({
    id: t.id,
    title: t.name,
    level: t.level ?? 'beginner',
    moves: t.exercises?.length ?? 0,
    location: t.isSystem ? 'gym' : 'home',
  }));

  return {
    state: 'active',
    settings,
    bounds,
    slots,
    items: formattedItems,
    layers,
    templates: formattedTemplates,
  };
}

export { todayIST, isFutureDate, buildWeek, getSessions };
