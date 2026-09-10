import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// The consent record that gates the OS-level HealthKit/Health Connect
// permission prompt — a fresh grant always overwrites revokedAt/policyVersion
// rather than requiring a separate "re-grant" path, since re-consenting after
// a revoke is just a grant with history.
export async function grantConsentService(userId, { policyVersion, platform }) {
  if (!policyVersion || !platform) {
    const err = new Error('policyVersion and platform are required');
    err.status = 400;
    throw err;
  }
  if (!['ios', 'android'].includes(platform)) {
    const err = new Error('platform must be ios or android');
    err.status = 400;
    throw err;
  }
  return prisma.healthConsent.upsert({
    where: { userId },
    update: { grantedAt: new Date(), revokedAt: null, policyVersion, platform },
    create: { userId, grantedAt: new Date(), policyVersion, platform },
  });
}

export async function revokeConsentService(userId) {
  const existing = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!existing) {
    const err = new Error('No consent on record');
    err.status = 404;
    throw err;
  }
  return prisma.healthConsent.update({
    where: { userId },
    data: { revokedAt: new Date() },
  });
}

export async function getConsentStatusService(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent) return { granted: false };
  return {
    granted: !consent.revokedAt,
    grantedAt: consent.grantedAt,
    revokedAt: consent.revokedAt,
    policyVersion: consent.policyVersion,
    platform: consent.platform,
  };
}

// Full wipe for this user, called both by the in-app "Revoke & delete" flow
// and by the account-deletion flow elsewhere in the platform. Deletes in
// FK-safe order; WorkoutSession -> SessionExercise -> WorkoutSet and
// WorkoutTemplate -> TemplateExercise cascade automatically (onDelete:
// Cascade in the schema), so only the top-level rows need explicit deletes.
// Custom exercises the user created are deleted too — their personal data,
// not the seeded shared library.
export async function deleteAllDataService(userId) {
  await prisma.$transaction([
    prisma.workoutSession.deleteMany({ where: { userId } }),
    prisma.workoutTemplate.deleteMany({ where: { userId } }),
    prisma.exercise.deleteMany({ where: { createdByUserId: userId } }),
    prisma.exerciseRecord.deleteMany({ where: { userId } }),
    prisma.dailyActivityMetric.deleteMany({ where: { userId } }),
    // Biometric entries (weight/body-fat today, resting HR/sleep/HRV once
    // Health+ Phase 1 lands) are among the most sensitive rows here, so they
    // must never outlive the account (the BRD's 30-day erasure line).
    prisma.biometricEntry.deleteMany({ where: { userId } }),
    // Suggestion impressions/votes are per-user behavioural data — the
    // aggregate GS-5 numbers are recomputed from what remains, never
    // retained per-user after deletion.
    prisma.suggestionFeedback.deleteMany({ where: { userId } }),
    // Personalisation (height/weight/injury zones/programming mode) goes
    // with the account too — including the consent record itself.
    prisma.personalisationProfile.deleteMany({ where: { userId } }),
    // The weekly training target is the user's own preference, so it goes
    // with the account like the rest of their record.
    prisma.weeklyGoal.deleteMany({ where: { userId } }),
    // Nudge suppression and the send log: per-user behavioural rows with
    // no purpose once the account is gone.
    prisma.nudgeOptOut.deleteMany({ where: { userId } }),
    prisma.nudgeLog.deleteMany({ where: { userId } }),
    // NOT deleted here: HealthDataAuditLog. It is the record of who touched
    // this person's health data, which is precisely the thing an erasure
    // request may later need to be evidenced against - deleting the audit
    // trail as part of the erasure would erase the proof the erasure
    // happened. It carries no health values by construction (actor, action,
    // data class, timestamp), and its userId stops resolving to a person
    // once auth-service's User row is gone. Same reasoning the financial
    // records in wallet/booking-service already rely on; see the
    // three-bucket note in retentionService.js.
    prisma.healthConsent.deleteMany({ where: { userId } }),
  ]);
}
