// Device registry (coach-journey B1). One row per app install a user has
// signed in on, keyed by a stable client-generated installId. The rows back
// referral/self-link abuse detection across accounts sharing a device (B2) and
// the "all devices for this user" read.
//
// Functions take the caller's PrismaClient rather than importing one, matching
// gymLinkService.js — so the controller owns the single client and tests can
// pass an in-memory double.

/**
 * Record (or refresh) an install for a user. Idempotent on (userId, installId):
 * a repeat sign-in on the same install returns the same row and only bumps
 * lastSeenAt.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ userId: number, installId: string, platform?: string|null }} input
 */
export async function upsertDevice(prisma, { userId, installId, platform = null }) {
  return prisma.userDevice.upsert({
    where: { userId_installId: { userId, installId } },
    update: { platform, lastSeenAt: new Date() },
    create: { userId, installId, platform },
  });
}

/** All user ids that have signed in on this install. @returns {Promise<number[]>} */
export async function listUserIdsForInstall(prisma, installId) {
  const rows = await prisma.userDevice.findMany({
    where: { installId },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/** All install ids this user has signed in on. @returns {Promise<string[]>} */
export async function listInstallIdsForUser(prisma, userId) {
  const rows = await prisma.userDevice.findMany({
    where: { userId },
    select: { installId: true },
  });
  return rows.map((row) => row.installId);
}
