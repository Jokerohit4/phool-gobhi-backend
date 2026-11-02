import { fetchInternal } from '../utils/fetchInternal.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';
import { isQualifyingSession } from './journey/showedUpDays.js';
import { routineRewardPolicy, istDay } from './routineRewardPolicy.js';
import { notifyWorkoutFinished } from '../utils/notifyChallengeService.js';
import { createTtlCache } from '../utils/ttlCache.js';
import { onJourneyInvalidate } from '../utils/journeyCacheBus.js';

// The "did this user already finish a qualifying workout?" repair read loads up
// to 100 sessions with nested sets and ran on every GET /habits/today until the
// state flag was set. Its only output is a boolean, so that is what is cached
// (per user, 5 min). The normal path (recordRoutineWorkout at finish) sets the
// flag directly; this is the self-heal for a crash between the write and the
// flag, so a few minutes of delay costs nothing. A workout finish emits
// journeyCacheBus, which evicts the entry immediately.
export const WORKOUT_REPAIR_TTL_MS = 5 * 60_000;
const workoutRepairCache = createTtlCache({ ttlMs: WORKOUT_REPAIR_TTL_MS, maxEntries: 5000 });
onJourneyInvalidate((userId) => workoutRepairCache.invalidate(String(userId)));

const AUTH = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const CHALLENGE = process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008';

// Crediting coins is a side effect of an already-saved drink/workout, not the
// record itself. It stays awaited so the response can report the award, but a
// cold or wedged challenge-service must not hold the request open: a cold
// /internal/coins/:id/credit took 3.05s against 0.65s warm (observed on
// health-service-dev, 2026-11). On timeout the durable claim stays pending and
// POST /habits/rewards/retry (or the next drink) pays it with the same
// idempotency key, so no coin is lost or double-paid.
const COIN_CREDIT_TIMEOUT_MS = 1_200;

export async function routineState(prisma, userId) {
  if (!await isFeatureEnabled('homeIntroduction')) return null;
  let state = await prisma.routineJourneyState.findUnique({ where: { userId } });
  if (!state) {
    const response = await fetchInternal(AUTH, `/internal/${userId}`);
    const accountCreatedAt = new Date(response.data?.createdAt);
    if (!Number.isFinite(accountCreatedAt.getTime())) return null;
    // Server account age, never a client timestamp or the resettable journey.
    state = await prisma.routineJourneyState.upsert({
      where: { userId }, update: {}, create: { userId, accountCreatedAt },
    });
  }
  return state;
}

export async function routineSnapshot(prisma, userId) {
  let state = await routineState(prisma, userId);
  if (!state) return null;
  // Recover saved outcomes if a process died between the activity write and
  // its progress update. Also restores progress on another device.
  // All four reads are independent: run them together.
  const [water, hasQualifying, rewardsEnabled, pendingClaims] = await Promise.all([
    !state.waterLoggedAt ? prisma.waterLog.findFirst({ where: { userId }, orderBy: { id: 'asc' } }) : null,
    !state.workoutCompletedAt
      ? workoutRepairCache.get(String(userId), async () => {
        const sessions = await prisma.workoutSession.findMany({
          where: { userId, endedAt: { not: null }, type: { not: null, notIn: ['rest'] } },
          orderBy: { endedAt: 'desc' }, take: 100,
          // Only what isQualifyingSession reads; all sets are kept with their completed flag.
          select: {
            type: true, endedAt: true, startedAt: true,
            exercises: { select: { sets: { select: { completed: true } } } },
          },
        });
        return sessions.some(isQualifyingSession);
      })
      : false,
    isFeatureEnabled('streaksCoins'),
    prisma.routineRewardClaim.count({ where: { userId, paidAt: null } }),
  ]);
  if (water || hasQualifying) {
    state = await prisma.routineJourneyState.update({ where: { userId }, data: {
      ...(water && !state.waterLoggedAt ? { waterLoggedAt: water.createdAt } : {}),
      ...(hasQualifying && !state.workoutCompletedAt ? { workoutCompletedAt: new Date() } : {}),
    } });
  }
  return {
    waterLogged: !!state.waterLoggedAt,
    workoutCompleted: !!state.workoutCompletedAt,
    rewardsEnabled,
    rewardsPending: pendingClaims > 0,
    policy: routineRewardPolicy(state.accountCreatedAt),
  };
}

export async function retryRoutineWorkouts(prisma, userId) {
  const sessions = await prisma.workoutSession.findMany({
    where: { userId, localDate: istDay(), endedAt: { not: null } },
    orderBy: { endedAt: 'desc' }, take: 20,
    include: { exercises: { include: { sets: true } } },
  });
  let coinsAwarded = 0;
  for (const session of sessions) {
    const policy = await recordRoutineWorkout(prisma, session);
    if (!policy || (!policy.starterAmount && !policy.verifiedAmount)) continue;
    const result = await notifyWorkoutFinished({ userId, sessionId: session.id,
      description: 'Workout activity', idempotencyKey: `workout-credit:${session.id}`, routinePolicy: policy });
    if (result.credited) coinsAwarded += result.amount || 0;
  }
  return coinsAwarded;
}

// Persist before attempting the other service. A timeout leaves the same key
// pending, so another attempt can never manufacture a second coin credit.
export async function payRoutineClaims(prisma, userId) {
  if (!await isFeatureEnabled('streaksCoins')) return { coinsAwarded: 0, pending: false };
  const pending = await prisma.routineRewardClaim.findMany({ where: { userId, paidAt: null } });
  let coinsAwarded = 0;
  for (const claim of pending) {
    try {
      await fetchInternal(CHALLENGE, `/internal/coins/${userId}/credit`, {
        method: 'POST', body: { amount: claim.amount, description: claim.description, idempotencyKey: claim.key },
        timeout: COIN_CREDIT_TIMEOUT_MS,
      });
      const marked = await prisma.routineRewardClaim.updateMany({
        where: { key: claim.key, paidAt: null }, data: { paidAt: new Date() },
      });
      if (marked.count) coinsAwarded += claim.amount;
    } catch {
      // The saved activity remains valid; the explicit retry route pays later.
    }
  }
  const left = await prisma.routineRewardClaim.count({ where: { userId, paidAt: null } });
  return { coinsAwarded, pending: left > 0 };
}

export async function recordRoutineWater(prisma, { userId, localDate, targetMl, replayed = false, now = new Date() }) {
  const state = await routineState(prisma, userId);
  if (!state) return { coinsAwarded: 0, pending: false };
  await prisma.routineJourneyState.updateMany({
    where: { userId, waterLoggedAt: null }, data: { waterLoggedAt: now },
  });
  if (replayed) return payRoutineClaims(prisma, userId);
  const policy = routineRewardPolicy(state.accountCreatedAt, now);
  if (!policy.eligible || localDate !== istDay(now) || !await isFeatureEnabled('streaksCoins')) {
    return { coinsAwarded: 0, pending: false };
  }
  if (!policy.waterLog && !policy.waterTarget) return payRoutineClaims(prisma, userId);
  // Serializable day counter closes simultaneous-log races. The immutable
  // target snapshot stops lowering a target to collect another reward.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await prisma.$transaction(async tx => {
        const day = await tx.routineWaterDay.upsert({
          where: { userId_localDate: { userId, localDate } }, update: {},
          create: { userId, localDate, targetMl },
        });
        const total = await tx.waterLog.aggregate({ where: { userId, localDate }, _sum: { ml: true } });
        const logged = Number(total._sum.ml || 0);
        const latest = await tx.routineWaterDay.findFirst({
          where: { userId, lastRewardAt: { not: null } }, orderBy: { lastRewardAt: 'desc' },
        });
        const lastRewardAt = latest?.lastRewardAt ?? day.lastRewardAt;
        const addClaim = (key, amount, description) => tx.routineRewardClaim.upsert({
          where: { key }, update: {}, create: { key, userId, amount, description },
        });
        if (policy.waterLog > 0 && day.rewardedLogs < policy.waterLogDailyCap &&
            logged <= day.targetMl && (!lastRewardAt || now - lastRewardAt >= 3600000)) {
          await addClaim(`routine:water:${userId}:${localDate}:log:${day.rewardedLogs + 1}`, 1, 'Water logged');
          await tx.routineWaterDay.update({
            where: { userId_localDate: { userId, localDate } },
            data: { rewardedLogs: { increment: 1 }, lastRewardAt: now },
          });
        }
        if (policy.waterTarget > 0 && day.targetMl > 0 && logged >= day.targetMl) {
          await addClaim(`routine:water:${userId}:${localDate}:target`, 1, 'Daily water target completed');
        }
      }, { isolationLevel: 'Serializable' });
      break;
    } catch (error) {
      if ((error.code !== 'P2034' && error.code !== 'P2002') || attempt === 3) throw error;
    }
  }
  return payRoutineClaims(prisma, userId);
}

export async function recordRoutineWorkout(prisma, session) {
  if (!isQualifyingSession(session)) return null;
  const state = await routineState(prisma, session.userId);
  if (!state) return null;
  await prisma.routineJourneyState.updateMany({
    where: { userId: session.userId, workoutCompletedAt: null }, data: { workoutCompletedAt: new Date() },
  });
  const policy = routineRewardPolicy(state.accountCreatedAt);
  // Coin eligibility is stricter than completing the onboarding step. Clock
  // values are created by the server; an instant empty finish earns nothing.
  if (!policy.eligible) return null;
  const elapsed = new Date(session.endedAt) - new Date(session.startedAt);
  if (session.localDate !== istDay() || elapsed < 10 * 60000 || elapsed > 24 * 3600000) {
    return { starterAmount: 0, verifiedAmount: 0 };
  }
  return { starterAmount: policy.workout, verifiedAmount: policy.locationWorkout,
    startedAt: session.startedAt, endedAt: session.endedAt, gymId: session.gymId ?? null };
}
