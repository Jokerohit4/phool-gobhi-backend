import { PrismaClient } from '@prisma/client';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { creditCoinsService } from './coinLedgerService.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';
import { challengeMatchesAudience } from './challengeAudience.js';

const prisma = new PrismaClient();

async function updateActiveEnrollment(enrollment, data) {
  await prisma.challengeEnrollment.updateMany({ where: { id: enrollment.id, status: 'active' }, data });
  return await prisma.challengeEnrollment.findUnique({ where: { id: enrollment.id } }) ?? enrollment;
}

export const PERSONAL_CHALLENGES = [
  { key: 'wellness_water_days_v1', type: 'water_consistency', audiences: ['wellness'], title: 'A little water, three days', description: 'Log water on three different days after joining. Follow your usual needs; extra glasses do not add progress.', rewardCoins: 5 },
  { key: 'wellness_mood_days_v1', type: 'mood_consistency', audiences: ['wellness'], title: 'Make room for yourself', description: 'Check in with Gobhi on three different days after joining. Every mood counts equally.', rewardCoins: 5 },
  { key: 'home_training_days_v1', type: 'workout_consistency', audiences: ['home_training'], title: 'Your space, your pace', description: 'Record a completed workout of at least 10 minutes on three different days after joining. Home sessions and other activities count.', rewardCoins: 10 },
  { key: 'own_gym_training_days_v1', type: 'workout_consistency', audiences: ['own_gym'], title: 'Build your own gym rhythm', description: 'Record a completed workout of at least 10 minutes on three different days after joining. No partner-gym booking is required.', rewardCoins: 10 },
  { key: 'linked_gym_training_days_v1', type: 'workout_consistency', audiences: ['linked_gym'], title: 'Show up and follow through', description: 'Complete and log at least 10 minutes of training on three different days after joining, with a verified gym attendance attached to each session.', rewardCoins: 10 },
  { key: 'explorer_water_days_v1', type: 'water_consistency', audiences: ['explorer'], title: 'Start with a small habit', description: 'Log water on three different days after joining. No workout or gym membership needed; extra glasses do not add progress.', rewardCoins: 5 },
];

export async function seedPersonalChallenges() {
  await prisma.$transaction(async tx => {
    // Cross-instance lock prevents duplicate seeds and duplicate reward quests.
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(918772)');
    for (const seed of PERSONAL_CHALLENGES) {
      const { rewardCoins, ...definition } = seed;
      const saved = await tx.challengeDefinition.upsert({
        where: { key: seed.key }, update: {},
        create: { ...definition, category: 'personal_habit', defaultVerificationMethod: 'activity_log' },
      });
      const existing = await tx.challenge.findFirst({ where: { challengeDefinitionId: saved.id, city: 'Anywhere' } });
      if (!existing) await tx.challenge.create({ data: {
        challengeDefinitionId: saved.id, city: 'Anywhere', targetCount: 3, rewardCoins,
      } });
    }
  });
}

// Progress is read from trusted health-service logs, never client counters.
//
// `audience` is the user's persona now. A challenge joined under a different
// persona is paused: shown, but neither advanced nor paid until the user is
// back in its audience. Without this a user could join one challenge per
// persona by switching and collect them all on the same water/workout logs.
export async function refreshPersonalChallenge(challenge, userId, audience) {
  const enrollment = challenge.enrollments?.[0];
  if (!enrollment || enrollment.status !== 'active') return challenge;
  if (audience && !challengeMatchesAudience(challenge, audience)) {
    return { ...challenge, pausedForPersona: true };
  }
  let count = enrollment.progressCount;
  if (enrollment.status !== 'completed') {
    const base = process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';
    const query = new URLSearchParams({
      userId: String(userId), since: new Date(enrollment.startedAt).toISOString(),
      metric: challenge.challengeDefinition.type,
      verifiedAttendance: String(challenge.challengeDefinition.audiences?.includes('linked_gym') ?? false),
    });
    try {
      const response = await fetch(`${base}/internal/challenge-activity?${query}`, {
        headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...await googleIdTokenHeader(base) },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Activity ${response.status}`);
      const data = (await response.json()).data;
      if (!Number.isInteger(data?.count) || data.count < 0) throw new Error('Invalid activity count');
      count = Math.min(challenge.targetCount, data.count);
    } catch (_) {
      // Keep the last confirmed progress; a failed read cannot complete a quest.
      return { ...challenge, progressUnavailable: true };
    }
  }
  if (count >= challenge.targetCount) {
    // Retry the same ledger key after partial failures; changing profiles or
    // reloading cannot create a second payment for this enrollment.
    if (challenge.rewardCoins > 0) {
      if (!await isFeatureEnabled('streaksCoins')) {
        const updated = await updateActiveEnrollment(enrollment, { progressCount: count });
        return { ...challenge, enrollments: [updated], rewardPending: true };
      }
      await creditCoinsService(userId, challenge.rewardCoins, `Completed challenge: ${challenge.id}`, `challenge-reward:${enrollment.id}`);
    }
    await prisma.rewardIssuance.upsert({ where: { enrollmentId: enrollment.id }, update: {},
      create: { enrollmentId: enrollment.id, rewardType: 'coins', coinAmount: challenge.rewardCoins } });
  }
  const updated = await updateActiveEnrollment(enrollment,
    { progressCount: count, ...(count >= challenge.targetCount ? { status: 'completed', completedAt: enrollment.completedAt ?? new Date() } : {}) });
  return { ...challenge, enrollments: [updated] };
}
