import { isoDayIST } from '../../utils/sessionDay.js';
import prisma from '../../db/prisma.js';
import { JOURNEY, elapsedJourneyDays, LAYER_OF_LAYER_KEY, layerKeysUpTo, earlyAllowedForLayerKey, startLayerFor } from './journeyConfig.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getShowedUpDays, getLastShowedUpDate } from './showedUpDays.js';
import { createTtlCache } from '../../utils/ttlCache.js';
import { onJourneyInvalidate, emitJourneyInvalidate } from '../../utils/journeyCacheBus.js';
import { countSteadyWeeks } from './steadyWeeks.js';
import { checkAndTriggerHomeDaysReferral } from './referralHomeTrigger.js';
import { rebuildPlan } from '../plan/rebuildPlan.js';
import { fetchUserProfileInternal } from '../../utils/fetchUserProfile.js';
import { isWellnessProfile } from '../../utils/persona.js';


const DEFAULT_EXPERIENCE_LEVEL = 'new_to_gym';

// The unlock rule of a LAYER, by its layer key ('food', 'body', ...). Callers used
// unlockConfigForLayerKey(layer.key), but that helper looks up by ROW key
// ('steps', 'sleep', 'workout', ...). The two only coincide for some layers, so
// the 'body' layer (rows steps/sleep) always resolved to null and the "next
// unlock" hint went missing for the whole week between food and body unlocking.
function unlockConfigForLayerName(layerName) {
  return JOURNEY.layers.find((l) => l.key === layerName)?.unlock ?? null;
}

function todayLocalDate() {
  return isoDayIST(new Date());
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

  if (progress.wellnessOnly) {
    const focuses = new Set(progress.wellnessFocuses ?? []);
    unlocked.push({ layer: 1, at: progress.startedAt?.toISOString() ?? now, via: 'start_level' });
    if (focuses.has('balanced_eating')) unlocked.push({ layer: 2, at: progress.startedAt?.toISOString() ?? now, via: 'wellness_focus' });
    if (focuses.has('sleep') || focuses.has('daily_movement') || focuses.has('energy')) {
      unlocked.push({ layer: 3, at: progress.startedAt?.toISOString() ?? now, via: 'wellness_focus' });
    }
  }

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
    unlocked.push({ layer: 2, at: new Date(`${thirdDay}T00:00:00Z`).toISOString(), via: 'showed_up' });
  } else if (progress.foodEarlyAt) {
    unlocked.push({ layer: 2, at: progress.foodEarlyAt.toISOString(), via: 'early' });
  }

  // Calendar time since the server-owned journey start; activity cannot
  // fast-forward these dates. Existing/start-level unlocks remain available.
  const elapsed = elapsedJourneyDays(progress.startedAt);
  for (const cfg of JOURNEY.layers.filter(l => l.unlock.type === 'elapsed_days')) {
    if (elapsed >= cfg.unlock.need) {
      unlocked.push({ layer: cfg.layer, at: new Date(new Date(progress.startedAt).getTime() + cfg.unlock.need * 86400000).toISOString(), via: 'elapsed_days' });
    }
  }

  // Existing users: unlock layers they already have data in
  // food logs -> layer 2, steps/sleep -> layer 3, health profile/docs -> layer 5
  const [foodLogs, stepLogs, sleepLogs, healthProfile, medicalDocs] = await Promise.all([
    prisma.foodLog.findFirst({ where: { userId }, select: { id: true } }),
    prisma.biometricEntry.findFirst({ where: { userId, metric: 'steps' }, select: { id: true } }),
    prisma.biometricEntry.findFirst({ where: { userId, metric: 'sleep_minutes' }, select: { id: true } }),
    prisma.healthProfile.findUnique({ where: { userId }, select: { userId: true, createdAt: true } }),
    prisma.medicalDocument.findFirst({ where: { userId }, select: { id: true } }),
  ]);

  const existingUnlocks = [];
  if (foodLogs && !unlocked.some((u) => u.layer === 2)) existingUnlocks.push({ layer: 2, at: now, via: 'existing' });
  if ((stepLogs || sleepLogs) && !unlocked.some((u) => u.layer === 3)) existingUnlocks.push({ layer: 3, at: now, via: 'existing' });
  if (((healthProfile && new Date(healthProfile.createdAt) < new Date('2026-10-26T00:00:00+05:30')) || medicalDocs) && !unlocked.some((u) => u.layer === 5)) existingUnlocks.push({ layer: 5, at: now, via: 'existing' });

  // Merge, keeping the earliest unlock for each layer
  const merged = new Map();
  for (const u of [...(progress.unlocked ?? []), ...unlocked, ...existingUnlocks]) {
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
    const unlock = unlockConfigForLayerName(nextLocked.key);
    if (unlock && unlock.type === 'showed_up_days') {
      next = { layer: nextLocked.layer, type: 'showed_up_days', have: showedUpDays.length, need: unlock.need };
    } else if (unlock && unlock.type === 'elapsed_days') {
      next = { layer: nextLocked.layer, type: 'elapsed_days', have: elapsedJourneyDays(progress.startedAt), need: unlock.need };
    } else if (unlock && unlock.type === 'steady_weeks') {
      next = { layer: nextLocked.layer, type: 'steady_weeks', have: steadyWeeks, need: unlock.need };
    }
  }

  return {
    wellnessOnly: progress.wellnessOnly === true,
    wellnessFocuses: progress.wellnessFocuses ?? [],
    wellnessDayPattern: progress.wellnessDayPattern ?? null,
    wellnessSleepPattern: progress.wellnessSleepPattern ?? null,
    startLevel,
    layers,
    next,
    showedUpDates: showedUpDays,
    showedUpDays: showedUpDays.length,
    steadyWeeks,
    elapsedDays: elapsedJourneyDays(progress.startedAt),
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
async function syncUnlocks(userId, progress, computed, lastShowedUpDate = progress.lastShowedUpDate) {
  const existing = progress.unlocked ?? [];
  const newUnlocks = computed.filter(u => !existing.some(e => e.layer === u.layer));
  // Only write when something actually changed. This used to write on EVERY read
  // for any user with a showed-up day (the early return only fired when
  // lastShowedUpDate was null), which made GET /journey and GET /plan/today
  // writers: an extra DB round-trip each, and two parallel app calls raced on the
  // updatedAt guard and retried. A changed lastShowedUpDate with no new unlock is
  // persisted by getJourney itself.
  if (newUnlocks.length === 0) {
    return { updated: false, progress };
  }
  // conditional update to avoid concurrent races
  let conflicted = false;
  const updated = await prisma.journeyProgress.update({
    where: { userId, updatedAt: progress.updatedAt },
    data: {
      unlocked: computed,
      lastShowedUpDate,
      updatedAt: new Date(),
    },
  }).catch(async err => {
    // conflict, retry once
    conflicted = true;
    const fresh = await prisma.journeyProgress.findUnique({ where: { userId } });
    if (!fresh) return null;
    return await syncUnlocks(userId, fresh, computed, lastShowedUpDate);
  });
  // The retry returns {updated, progress}; the happy path returns the row itself.
  if (conflicted && updated) return updated;
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
// getJourney is the hottest read in the service: GET /plan/today, /plan,
// /journey and the layer/score helpers all call it, and one app launch fires
// several of those at once. Cached per user for a few seconds with single-flight
// loading (parallel callers share one computation). Every write path in this
// module — and workout finish / consent erase via invalidateJourneyCaches — evicts.
const JOURNEY_TTL_MS = Number(process.env.JOURNEY_CACHE_TTL_MS ?? 5_000);
const journeyCache = createTtlCache({ ttlMs: JOURNEY_TTL_MS });
// rebuildPlan (reached from syncUnlocks inside a load) calls getJourney again via
// getOnLayerKeys → getLayers. Joining the in-flight load from inside itself would
// deadlock, so a nested call for the same user bypasses the cache.
const journeyLoadContext = new AsyncLocalStorage();

/**
 * Drop a user's cached journey (and, via the bus, their cached showed-up days).
 * Call after anything that changes either. Write paths outside this module
 * (workout finish, consent erase) emit on the same bus.
 */
export function invalidateJourneyCaches(userId) {
  emitJourneyInvalidate(userId);
}
onJourneyInvalidate((userId) => journeyCache.invalidate(Number(userId)));

export async function getJourney(userId) {
  if (journeyLoadContext.getStore() === Number(userId)) return computeJourney(userId);
  const journey = await journeyCache.get(
    Number(userId),
    () => journeyLoadContext.run(Number(userId), () => computeJourney(userId)),
    { cacheable: (value) => value !== null },
  );
  // Callers own their copy (the object is small plain data).
  return journey === null ? null : structuredClone(journey);
}

async function computeJourney(userId) {
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

  // Sync unlocks with conditional guard and rebuild (writes only on a new unlock).
  const { updated, progress: syncedProgress } = await syncUnlocks(userId, progress, unlockedLayers, lastShowedUpDate);
  progress = syncedProgress ?? progress;

  // Update lastShowedUpDate if changed without unlock
  if (lastShowedUpDate !== (progress.lastShowedUpDate ?? null)) {
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
  const profile = await fetchUserProfileInternal(userId);
  if (isWellnessProfile(profile)) {
    const err = new Error('Wellness profiles must start a wellbeing journey');
    err.status = 409;
    err.code = 'WELLNESS_JOURNEY_REQUIRED';
    throw err;
  }
  const level = experienceLevel ?? DEFAULT_EXPERIENCE_LEVEL;
  const startLayer = JOURNEY.startLayer[level] ?? 1;
  const easyStartUntil = (level === 'new_to_gym' || level === 'just_started' || level === 'restarting_after_break')
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
      wellnessOnly: false,
      wellnessFocuses: [],
      wellnessDayPattern: null,
      wellnessSleepPattern: null,
      // Don't reset easyStartUntil or startedAt on re-run
    },
  });
  // Back from wellness: bring back the workout unlocks (early food, earned
  // layers) the wellbeing plan set aside.
  if (progress.workoutSnapshot?.unlocked) {
    await prisma.journeyProgress.update({
      where: { userId },
      data: { unlocked: progress.workoutSnapshot.unlocked, workoutSnapshot: null },
    });
  }

  // Call starterPlanService to create the starter plan
  const { createStarterPlan } = await import('../ledger/starterPlanService.js');
  const plan = await createStarterPlan(prisma, userId, {
    experienceLevel: level,
    goals,
    daysPerWeek,
    location,
  });

  invalidateJourneyCaches(userId);
  return { journey: await getJourney(userId), plan };
}

/** Starts a wellbeing plan from the saved onboarding preferences, without
 * workout goals, workout slots, or a weekly workout goal.
 *
 * Non-destructive for someone moving over from a workout plan: their workout
 * unlocks and slots are kept in JourneyProgress.workoutSnapshot (restored by
 * switchJourneyTrack / startJourney), and their WeeklyGoal is left alone —
 * the wellbeing reads already ignore it (todayService zeroes sessionsPerWeek
 * for wellnessOnly), and deleting it only lost the target they had chosen. */
export async function startWellnessJourney(userId) {
  const profile = await fetchUserProfileInternal(userId);
  if (!isWellnessProfile(profile)) {
    const err = new Error('A wellbeing-only onboarding profile is required');
    err.status = 400;
    err.code = 'WELLNESS_PROFILE_REQUIRED';
    throw err;
  }
  const focuses = Array.isArray(profile.wellnessFocuses) ? profile.wellnessFocuses : [];
  const startedAt = new Date();
  const at = startedAt.toISOString();
  const unlocked = [{ layer: 1, at, via: 'start' }];
  if (focuses.includes('balanced_eating')) unlocked.push({ layer: 2, at, via: 'wellness_focus' });
  if (focuses.some((focus) => ['sleep', 'daily_movement', 'energy'].includes(focus))) {
    unlocked.push({ layer: 3, at, via: 'wellness_focus' });
  }
  const easyStartUntil = addDays(todayLocalDate(), JOURNEY.easyStartDays);
  const workoutSnapshot = await snapshotWorkoutTrack(userId);
  await prisma.journeyProgress.upsert({
    where: { userId },
    create: {
      userId, startLevel: 'new_to_gym', startedAt, unlocked, easyStartUntil,
      wellnessOnly: true, wellnessFocuses: focuses,
      wellnessDayPattern: profile.wellnessDayPattern ?? null,
      wellnessSleepPattern: profile.wellnessSleepPattern ?? null,
    },
    update: {
      startLevel: 'new_to_gym', wellnessOnly: true, wellnessFocuses: focuses,
      wellnessDayPattern: profile.wellnessDayPattern ?? null,
      wellnessSleepPattern: profile.wellnessSleepPattern ?? null,
      unlocked,
      ...(workoutSnapshot ? { workoutSnapshot } : {}),
    },
  });
  const { createStarterPlan } = await import('../ledger/starterPlanService.js');
  const plan = await createStarterPlan(prisma, userId, {
    experienceLevel: 'new_to_gym', goals: [], location: 'home', daysPerWeek: 0,
    wellnessOnly: true, wellnessProfile: profile,
  });
  invalidateJourneyCaches(userId);
  return { journey: await getJourney(userId), plan };
}

// The workout side of a journey that a wellbeing plan is about to replace:
// what was unlocked, the start level, and the prescription's workout slots and
// step target. Null when there is no workout journey to keep (none yet, or
// already wellness-only — never overwrite an existing snapshot with a
// wellness one).
async function snapshotWorkoutTrack(userId) {
  const [progress, prescription] = await Promise.all([
    prisma.journeyProgress.findUnique({ where: { userId } }),
    prisma.prescription.findUnique({ where: { userId } }),
  ]);
  if (!progress || progress.wellnessOnly) return null;
  return {
    unlocked: progress.unlocked ?? [],
    startLevel: progress.startLevel,
    workoutSlots: prescription?.workoutSlots ?? null,
    stepsPerDay: prescription?.stepsPerDay ?? null,
    at: new Date().toISOString(),
  };
}

/**
 * auth-service: the user switched persona (POST /internal/journey/persona-changed).
 * Swaps the plan between the workout and wellbeing tracks without losing
 * either: into wellness snapshots the workout track and starts the wellbeing
 * plan; out of it restores the snapshot. A user with no journey yet is left
 * alone — the app starts one in their new persona.
 */
export async function switchJourneyTrack(userId, toPersona) {
  const progress = await prisma.journeyProgress.findUnique({ where: { userId } });
  if (!progress) return { changed: false, reason: 'no_journey' };
  const toWellness = toPersona === 'wellness';
  if (toWellness === progress.wellnessOnly) return { changed: false, reason: 'same_track' };
  invalidateJourneyCaches(userId);

  if (toWellness) {
    await startWellnessJourney(userId);
    return { changed: true, track: 'wellness' };
  }

  const snapshot = progress.workoutSnapshot;
  await prisma.journeyProgress.update({
    where: { userId },
    data: {
      wellnessOnly: false,
      ...(snapshot ? { unlocked: snapshot.unlocked ?? progress.unlocked, startLevel: snapshot.startLevel ?? progress.startLevel } : {}),
      workoutSnapshot: null,
    },
  });
  // Without a snapshot this user never had a workout plan; the app offers to
  // build one (POST /journey/start) instead of us inventing slots here.
  if (snapshot?.workoutSlots) {
    await prisma.prescription.updateMany({
      where: { userId },
      data: {
        workoutSlots: snapshot.workoutSlots,
        ...(snapshot.stepsPerDay != null ? { stepsPerDay: snapshot.stepsPerDay } : {}),
      },
    });
  }
  invalidateJourneyCaches(userId);
  await rebuildPlan(prisma, userId, { reason: 'persona_switch' });
  return { changed: true, track: 'workout', restored: Boolean(snapshot) };
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
  invalidateJourneyCaches(userId);

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
  const startLevelForSummary = progress.startLevel ?? DEFAULT_EXPERIENCE_LEVEL;

  // The unlock computation and the weekly score delta are independent of each
  // other (both only need showedUpDays / today) — start them together instead of
  // paying their DB round-trips back to back.
  const unlockedLayersPromise = computeUnlockedLayers(userId, progress, showedUpDays, steadyWeeks, startLevelForSummary);
  unlockedLayersPromise.catch(() => {}); // surfaced where awaited below
  const weekDeltaPromise = (async () => {
    try {
      // dynamic import to avoid circular deps
      const { weekDelta: weekDeltaFn } = await import('../ledger/scoreService.js');
      return await weekDeltaFn(prisma, { userId, today: todayLocalDate() });
    } catch {
      return null;
    }
  })();

  // This week's showed-up days (Monday-start week)
  const today = todayLocalDate();
  const todayDate = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = todayDate.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(todayDate);
  monday.setUTCDate(todayDate.getUTCDate() + mondayOffset);
  const mondayStr = monday.toISOString().slice(0, 10);
  const showedUpThisWeek = showedUpDays.filter((d) => d >= mondayStr).length;

  // Total showed-up days
  const showedUpTotal = showedUpDays.length;

  // Score visibility: true when journey started 14+ days ago
  const startedAt = progress.startedAt?.toISOString().slice(0, 10) ?? today;
  const daysSinceStart = daysSince(startedAt);
  const scoreVisible = daysSinceStart >= 14;

  // weekDelta from B10's scoreService (started above, in parallel)
  const [weekDelta, unlockedLayers] = await Promise.all([weekDeltaPromise, unlockedLayersPromise]);

  // Next unlock info
  const layers = JOURNEY.layers.map((l) => {
    const unlocked = unlockedLayers.find((u) => u.layer === l.layer);
    return { layer: l.layer, key: l.key, unlocked: !!unlocked };
  });
  const nextLocked = layers.find((l) => !l.unlocked);
  let nextUnlock = null;
  if (nextLocked) {
    const unlock = unlockConfigForLayerName(nextLocked.key);
    if (unlock && unlock.type === 'showed_up_days') {
      nextUnlock = { label: `Layer ${nextLocked.layer} (${nextLocked.key})`, have: showedUpDays.length, need: unlock.need };
    } else if (unlock && unlock.type === 'elapsed_days') {
      // Was `next = {...}` on an undeclared variable: a ReferenceError (ESM is
      // strict) the moment the next locked layer was a time-based one.
      nextUnlock = { label: `Layer ${nextLocked.layer} (${nextLocked.key})`, have: elapsedJourneyDays(progress.startedAt), need: unlock.need };
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
