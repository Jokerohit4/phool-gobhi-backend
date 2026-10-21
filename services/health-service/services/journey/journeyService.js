import { PrismaClient } from '@prisma/client';
import { JOURNEY, LAYER_OF_LAYER_KEY, layerKeysUpTo, unlockConfigForLayerKey, earlyAllowedForLayerKey, startLayerFor } from './journeyConfig.js';
import { getShowedUpDays, getLastShowedUpDate } from './showedUpDays.js';
import { countSteadyWeeks, getSteadyWeeksDetail } from './steadyWeeks.js';
import { checkAndTriggerHomeDaysReferral } from './referralHomeTrigger.js';
import { rebuildPlan } from '../plan/rebuildPlan.js';

const prisma = new PrismaClient();

const DEFAULT_EXPERIENCE_LEVEL = 'new_to_gym';

function todayLocalDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysSince(dateStr) {
  const today = todayLocalDate();
  const start = new Date(`${dateStr}T00:00:00Z`);
  const end = new Date(`${today}T00:00:00Z`);
  return Math.floor((end - start) / (1000 * 60 * 60 * 24));
}

/**
 * Determine which layers should be unlocked for a user based on their
 * showed-up days, steady weeks, and existing data.
 * Returns array of { layer, at: ISO string, via: 'start'|'showed_up'|'steady_weeks'|'early'|'existing' }.
 */
async function computeUnlockedLayers(userId, progress, showedUpDays, steadyWeeks, startLevel) {
  const now = new Date().toISOString();
  const unlocked = [];
  const startLayer = startLayerFor(startLevel);

  // Layers up to startLayer unlocked via start_level on every read
  for (let layer = 1; layer <= startLayer; layer++) {
    if (!unlocked.some(u => u.layer === layer)) {
      unlocked.push({ layer, at: progress.startedAt?.toISOString() ?? now, via: 'start_level' });
    }
  }

  // Layer 2 (food) - 3 showed-up days or early request
  const foodUnlock = JOURNEY.layers.find((l) => l.key === 'food');
  if (showedUpDays.length >= foodUnlock.unlock.need) {
    // Find when the 3rd day was reached
    const thirdDay = showedUpDays[showedUpDays.length - foodUnlock.unlock.need];
    unlocked.push({ layer: 2, at: new Date(`${thirdDay}T00:00:00`).toISOString(), via: 'showed_up' });
  } else if (progress.foodEarlyAt) {
    unlocked.push({ layer: 2, at: progress.foodEarlyAt.toISOString(), via: 'early' });
  }

  // Layer 3 (body) - 2 steady weeks
  const bodyUnlock = JOURNEY.layers.find((l) => l.key === 'body');
  if (steadyWeeks >= bodyUnlock.unlock.need) {
    const detail = getSteadyWeeksDetail(showedUpDays);
    if (detail.length >= bodyUnlock.unlock.need) {
      const secondWeekStart = detail[detail.length - bodyUnlock.unlock.need].weekStart;
      unlocked.push({ layer: 3, at: new Date(`${secondWeekStart}T00:00:00`).toISOString(), via: 'steady_weeks' });
    }
  }

  // Layer 4 (supplements) - 4 steady weeks
  const suppUnlock = JOURNEY.layers.find((l) => l.key === 'supplements');
  if (steadyWeeks >= suppUnlock.unlock.need) {
    const detail = getSteadyWeeksDetail(showedUpDays);
    if (detail.length >= suppUnlock.unlock.need) {
      const fourthWeekStart = detail[detail.length - suppUnlock.unlock.need].weekStart;
      unlocked.push({ layer: 4, at: new Date(`${fourthWeekStart}T00:00:00`).toISOString(), via: 'steady_weeks' });
    }
  }

  // Layer 5 (health) - 6 steady weeks
  const healthUnlock = JOURNEY.layers.find((l) => l.key === 'health');
  if (steadyWeeks >= healthUnlock.unlock.need) {
    const detail = getSteadyWeeksDetail(showedUpDays);
    if (detail.length >= healthUnlock.unlock.need) {
      const sixthWeekStart = detail[detail.length - healthUnlock.unlock.need].weekStart;
      unlocked.push({ layer: 5, at: new Date(`${sixthWeekStart}T00:00:00`).toISOString(), via: 'steady_weeks' });
    }
  }

  // Existing users: unlock layers they already have data in
  // food logs -> layer 2, steps/sleep -> layer 3, health profile/docs -> layer 5
  const [foodLogs, stepLogs, sleepLogs, healthProfile, medicalDocs] = await Promise.all([
    prisma.foodLog.findFirst({ where: { userId }, select: { id: true } }),
    prisma.biometricEntry.findFirst({ where: { userId, metric: 'steps' }, select: { id: true } }),
    prisma.biometricEntry.findFirst({ where: { userId, metric: 'sleep_minutes' }, select: { id: true } }),
    prisma.healthProfile.findUnique({ where: { userId }, select: { userId: true } }),
    prisma.medicalDocument.findFirst({ where: { userId }, select: { id: true } }),
  ]);

  const existingUnlocks = [];
  if (foodLogs && !unlocked.some((u) => u.layer === 2)) existingUnlocks.push({ layer: 2, at: now, via: 'existing' });
  if ((stepLogs || sleepLogs) && !unlocked.some((u) => u.layer === 3)) existingUnlocks.push({ layer: 3, at: now, via: 'existing' });
  if ((healthProfile || medicalDocs) && !unlocked.some((u) => u.layer === 5)) existingUnlocks.push({ layer: 5, at: now, via: 'existing' });

  // Merge, keeping the earliest unlock for each layer
  const merged = new Map();
  for (const u of [...unlocked, ...existingUnlocks]) {
    if (!merged.has(u.layer) || new Date(u.at) < new Date(merged.get(u.layer).at)) {
      merged.set(u.layer, u);
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.layer - b.layer);
}

/**
 * Build the journey response object per the API contract.
 */
function buildJourneyResponse(progress, unlockedLayers, showedUpDays, steadyWeeks, startLevel, easeBack, refreshProposal, milestones) {
  const layers = JOURNEY.layers.map((l) => {
    const unlocked = unlockedLayers.find((u) => u.layer === l.layer);
    return {
      layer: l.layer,
      key: l.key,
      unlocked: !!unlocked,
      unlockedAt: unlocked?.at ?? null,
      earlyAllowed: l.earlyAllowed === true,
    };
  });

  // Find next unlock
  const nextLocked = layers.find((l) => !l.unlocked);
  let next = null;
  if (nextLocked) {
    const unlock = unlockConfigForLayerKey(nextLocked.key);
    if (unlock && unlock.type === 'showed_up_days') {
      next = { layer: nextLocked.layer, type: 'showed_up_days', have: showedUpDays.length, need: unlock.need };
    } else if (unlock && unlock.type === 'steady_weeks') {
      next = { layer: nextLocked.layer, type: 'steady_weeks', have: steadyWeeks, need: unlock.need };
    }
  }

  return {
    startLevel,
    layers,
    next,
    showedUpDates: showedUpDays,
    showedUpDays: showedUpDays.length,
    steadyWeeks,
    easyStartUntil: progress.easyStartUntil ?? null,
    foodEarly: !!progress.foodEarlyAt,
    easeBack,
    refreshProposal,
    milestones,
  };
}

/**
 * Persist computed unlocks with conditional update guard, emit events and rebuild plan.
 */
async function syncUnlocks(userId, progress, computed) {
  const existing = progress.unlocked ?? [];
  const newUnlocks = computed.filter(u => !existing.some(e => e.layer === u.layer));
  if (newUnlocks.length === 0 && (progress.lastShowedUpDate === null || progress.lastShowedUpDate === undefined)) {
    return { updated: false, progress };
  }
  // conditional update to avoid concurrent races
  const updated = await prisma.journeyProgress.update({
    where: { userId, updatedAt: progress.updatedAt },
    data: {
      unlocked: computed,
      lastShowedUpDate: progress.lastShowedUpDate,
      updatedAt: new Date(),
    },
  }).catch(async err => {
    // conflict, retry once
    const fresh = await prisma.journeyProgress.findUnique({ where: { userId } });
    if (!fresh) return null;
    return await syncUnlocks(userId, fresh, computed);
  });
  if (!updated) return { updated: false, progress };
  // emit layer_unlocked per new layer; how mapping from via
  for (const u of newUnlocks) {
    const howMap = { start_level: 'start_level', showed_up: 'showed_up', steady_weeks: 'steady_weeks', early: 'early', existing: 'existing_data' };
    // emit placeholder – actual event emitter can be wired later
    // rebuild plan for unlock
    await rebuildPlan(prisma, userId, { reason: 'unlock', layer: u.layer, how: howMap[u.via] ?? u.via });
  }
  return { updated: true, progress: updated };
}

/**
 * Main journey service - gets or creates JourneyProgress, computes unlocks,
 * and returns the journey response.
 */
export async function getJourney(userId) {
  let progress = await prisma.journeyProgress.findUnique({ where: { userId } });

  if (!progress) {
    // Not started yet - caller should handle 404
    return null;
  }

  const startLevel = progress.startLevel ?? DEFAULT_EXPERIENCE_LEVEL;
  const showedUpDays = await getShowedUpDays(userId);
  const steadyWeeks = countSteadyWeeks(showedUpDays);
  const lastShowedUpDate = showedUpDays[0] ?? null;

  // Check for ease back: 7+ days since last showed-up day
  let easeBack = false;
  if (lastShowedUpDate) {
    const daysSinceLast = daysSince(lastShowedUpDate);
    easeBack = daysSinceLast >= JOURNEY.inactivePauseAfterDays;
  }

  // Check and trigger home-days referral (3rd showed-up day)
  await checkAndTriggerHomeDaysReferral(userId, showedUpDays, progress);

  // Compute unlocked layers
  const unlockedLayers = await computeUnlockedLayers(userId, progress, showedUpDays, steadyWeeks, startLevel);

  // Sync unlocks with conditional guard and rebuild
  const { updated, progress: syncedProgress } = await syncUnlocks(userId, { ...progress, lastShowedUpDate }, unlockedLayers);
  progress = syncedProgress ?? progress;

  // Update lastShowedUpDate if changed without unlock
  if (lastShowedUpDate !== progress.lastShowedUpDate) {
    progress = await prisma.journeyProgress.update({
      where: { userId },
      data: { lastShowedUpDate },
    });
  }

  // Milestones for experienced users
  const milestones = JOURNEY.milestones.map((m) => {
    let achieved = false;
    if (m.needSteadyWeeks != null) achieved = steadyWeeks >= m.needSteadyWeeks;
    if (m.needDaysSinceStart != null) achieved = daysSince(progress.startedAt?.toISOString().slice(0, 10) ?? todayLocalDate()) >= m.needDaysSinceStart;
    return { key: m.key, label: m.label, achieved };
  });

  const refreshProposal = null;

  return buildJourneyResponse(progress, unlockedLayers, showedUpDays, steadyWeeks, startLevel, easeBack, refreshProposal, milestones);
}

/**
 * Start a new journey for the user.
 * Called by POST /journey/start.
 */
export async function startJourney(userId, { experienceLevel, goals, daysPerWeek, location, quitReason }) {
  const level = experienceLevel ?? DEFAULT_EXPERIENCE_LEVEL;
  const startLayer = JOURNEY.startLayer[level] ?? 1;
  const easyStartUntil = (level === 'new_to_gym' || level === 'restarting_after_break')
    ? addDays(todayLocalDate(), JOURNEY.easyStartDays)
    : null;

  const progress = await prisma.journeyProgress.upsert({
    where: { userId },
    create: {
      userId,
      startLevel: level,
      startedAt: new Date(),
      unlocked: [{ layer: 1, at: new Date().toISOString(), via: 'start' }],
      easyStartUntil,
      quitReason: quitReason ?? null,
    },
    update: {
      startLevel: level,
      quitReason: quitReason ?? null,
      // Don't reset easyStartUntil or startedAt on re-run
    },
  });

  // Call starterPlanService to create the starter plan
  const { createStarterPlan } = await import('../ledger/starterPlanService.js');
  const plan = await createStarterPlan(prisma, userId, {
    experienceLevel: level,
    goals,
    daysPerWeek,
    location,
  });

  return { journey: await getJourney(userId), plan };
}

/**
 * Unlock food layer early (POST /journey/food-early).
 */
export async function unlockFoodEarly(userId) {
  const progress = await prisma.journeyProgress.findUnique({ where: { userId } });
  if (!progress) {
    const err = new Error('Journey not started');
    err.status = 404;
    err.code = 'JOURNEY_NOT_STARTED';
    throw err;
  }

  if (progress.foodEarlyAt) {
    return getJourney(userId);
  }

  await prisma.journeyProgress.update({
    where: { userId },
    data: { foodEarlyAt: new Date() },
  });

  // Rebuild plan for early unlock
  await rebuildPlan(prisma, userId, { reason: 'unlock', layer: 2, how: 'early' });

  return getJourney(userId);
}

/**
 * Export for B7's resolveUnlockedLayerKeys - returns array of unlocked layerKeys.
 */
export async function getUnlockedLayerKeys(userId) {
  const progress = await prisma.journeyProgress.findUnique({ where: { userId } });
  if (!progress) return ['workout', 'water']; // layer 1 only

  const showedUpDays = await getShowedUpDays(userId);
  const steadyWeeks = countSteadyWeeks(showedUpDays);
  const unlockedLayers = await computeUnlockedLayers(userId, progress, showedUpDays, steadyWeeks, progress.startLevel ?? DEFAULT_EXPERIENCE_LEVEL);

  await syncUnlocks(userId, progress, unlockedLayers);

  return unlockedLayers.flatMap((u) => {
    const layer = JOURNEY.layers.find((l) => l.layer === u.layer);
    return layer?.layerKeys ?? [];
  });
}

/**
 * Export for B10's scoreService - returns scoring window info.
 */
export async function getScoringWindow(userId) {
  const progress = await prisma.journeyProgress.findUnique({ where: { userId } });
  if (!progress) return null;

  const showedUpDays = await getShowedUpDays(userId);
  const lastShowedUpDate = showedUpDays[0] ?? null;
  const inactiveSince = lastShowedUpDate ? addDays(lastShowedUpDate, JOURNEY.inactivePauseAfterDays) : null;
  const easyStartUntil = progress.easyStartUntil ? addDays(progress.easyStartUntil, 0) : null; // already a date string
  const foodEarlyNoPenaltyUntilUnlock = progress.foodEarlyAt ? null : (progress.unlocked?.find((u) => u.layer === 2) ? null : true);

  return {
    easyStartUntil: progress.easyStartUntil,
    inactiveSince,
    foodEarlyNoPenaltyUntilUnlock: !progress.foodEarlyAt && !progress.unlocked?.some((u) => u.layer === 2),
  };
}

/**
 * Get journey summary for the Home screen (GET /journey/summary).
 */
export async function getJourneySummary(userId) {
  const progress = await prisma.journeyProgress.findUnique({ where: { userId } });
  if (!progress) {
    const err = new Error('Journey not started');
    err.status = 404;
    err.code = 'JOURNEY_NOT_STARTED';
    throw err;
  }

  const showedUpDays = await getShowedUpDays(userId);
  const steadyWeeks = countSteadyWeeks(showedUpDays);

  // This week's showed-up days (Monday-start week)
  const today = todayLocalDate();
  const todayDate = new Date(`${today}T00:00:00`);
  const dayOfWeek = todayDate.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(todayDate);
  monday.setDate(todayDate.getDate() + mondayOffset);
  const mondayStr = monday.toISOString().slice(0, 10);
  const showedUpThisWeek = showedUpDays.filter((d) => d >= mondayStr).length;

  // Total showed-up days
  const showedUpTotal = showedUpDays.length;

  // Score visibility: true when journey started 14+ days ago
  const startedAt = progress.startedAt?.toISOString().slice(0, 10) ?? today;
  const daysSinceStart = daysSince(startedAt);
  const scoreVisible = daysSinceStart >= 14;

  // weekDelta from B10's scoreService - dynamic import to avoid circular deps
  let weekDelta = null;
  try {
    const { weekDelta: weekDeltaFn } = await import('../ledger/scoreService.js');
    weekDelta = await weekDeltaFn(prisma, { userId, today });
  } catch {
    weekDelta = null;
  }

  // Next unlock info
  const unlockedLayers = await computeUnlockedLayers(userId, progress, showedUpDays, steadyWeeks, progress.startLevel ?? DEFAULT_EXPERIENCE_LEVEL);
  const layers = JOURNEY.layers.map((l) => {
    const unlocked = unlockedLayers.find((u) => u.layer === l.layer);
    return { layer: l.layer, key: l.key, unlocked: !!unlocked };
  });
  const nextLocked = layers.find((l) => !l.unlocked);
  let nextUnlock = null;
  if (nextLocked) {
    const unlock = unlockConfigForLayerKey(nextLocked.key);
    if (unlock && unlock.type === 'showed_up_days') {
      nextUnlock = { label: `Layer ${nextLocked.layer} (${nextLocked.key})`, have: showedUpDays.length, need: unlock.need };
    } else if (unlock && unlock.type === 'steady_weeks') {
      nextUnlock = { label: `Layer ${nextLocked.layer} (${nextLocked.key})`, have: steadyWeeks, need: unlock.need };
    }
  }

  return {
    showedUpThisWeek,
    steadyWeeks,
    showedUpTotal,
    score: { visible: scoreVisible, weekDelta },
    nextUnlock,
  };
}