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
    prisma.healthConsent.deleteMany({ where: { userId } }),
  ]);
}
