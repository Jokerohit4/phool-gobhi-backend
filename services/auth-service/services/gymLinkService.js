// Gym-link service — MINIMAL STUB as of A1 (2026-10-16).
//
// A1 only ships the signature and the denormalised write so B2 has a stable
// seam to build the real link/unlink flow against. linkGym mirrors the existing
// login/join behaviour in authService.js: linkedGymId is set only while it is
// null, so the first link wins and later ones do not silently reassign the
// home-gym pointer.
//
// B2 extends this to also write a GymLink row (source, linkedAt) and to enforce
// the self-link block/limit rules — do not add that here in A1.

/**
 * Point a user at a gym. Sets User.linkedGymId only when it is currently null,
 * matching the login/join-link backfill in authService.js (once set, immutable).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {number} gymId
 * @param {'self'|'gym_qr'} source GymLinkSource; unused until B2 writes GymLink
 * @returns {Promise<import('@prisma/client').User>} the updated (or unchanged) user
 */
export async function linkGym(prisma, userId, gymId, source) { // eslint-disable-line no-unused-vars
  const resolvedGymId = Number.isInteger(Number(gymId)) && Number(gymId) > 0 ? Number(gymId) : null;
  if (!resolvedGymId) return null;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  if (user.linkedGymId) return user;

  return prisma.user.update({
    where: { id: userId },
    data: { linkedGymId: resolvedGymId },
  });
}
