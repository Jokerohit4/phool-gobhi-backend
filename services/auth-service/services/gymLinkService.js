// Gym-link service (coach-journey B2).
//
// A GymLink is the durable record of "this customer is a member of this gym".
// User.linkedGymId stays the cached pointer to the active link (so the
// re-engagement sweep, the join-attribution analytics and the app's Home branch
// all keep working unchanged); GymLink adds the history the pointer can't hold:
// how the link was made (QR vs self-declared), when, whether a verified
// check-in ever happened, and whether the gym removed the person.
//
// One DB for one service: UserDevice (install ids) lives in this same auth
// database, so the self-link device limit is a local read — no cross-service
// call, no new seam.

import { FEATURE_FLAGS } from '../config/featureFlagRegistry.js';

// A self-link is a membership claim the gym can end up billed for, so it is
// deliberately rate-limited: one self-link per month, and no more than a few
// per physical device (install id) across all accounts on that device.
const SELF_LINK_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const SELF_LINK_DEVICE_LIMIT = 3;

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Effective state of the selfLinkGym flag: an admin's explicit app-config
// override wins, otherwise fall back to the flag registry default. Kept here
// (rather than a middleware) because only the two self-link routes gate on it,
// and both already have a Prisma client in hand.
export async function isSelfLinkGymEnabled(prisma) {
  const row = await prisma.appVersionSetting.findUnique({ where: { id: 1 } });
  const stored = row?.config?.features?.selfLinkGym?.enabled;
  if (typeof stored === 'boolean') return stored;
  const flag = FEATURE_FLAGS.find((f) => f.name === 'selfLinkGym');
  return flag ? flag.defaultEnabled : false;
}

// The user's current link, if any. Null once they have left or been removed.
export async function getActiveLink(prisma, userId) {
  return prisma.gymLink.findFirst({
    where: { userId, removedAt: null },
    orderBy: { linkedAt: 'desc' },
  });
}

/**
 * Point a user at a gym and record the link. In one transaction: close any
 * active link for the user (without blocking), create the new GymLink, and set
 * User.linkedGymId. The pointer is set only while it is null, so the first link
 * wins — a later QR/self-link never silently reassigns an existing home gym.
 *
 * Only `source: 'self'` can throw (SELF_LINK_BLOCKED / SELF_LINK_LIMIT); the
 * QR path is the existing join/backfill behaviour and must never fail the login.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {number} gymId
 * @param {'self'|'gym_qr'} source
 * @returns {Promise<import('@prisma/client').User|null>} the updated (or unchanged) user
 */
export async function linkGym(prisma, userId, gymId, source) {
  const resolvedGymId = toPositiveInt(gymId);
  if (!resolvedGymId) return null;
  const resolvedSource = source === 'self' ? 'self' : 'gym_qr';

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    if (user.linkedGymId) return user;

    if (resolvedSource === 'self') {
      await assertSelfLinkAllowed(tx, userId, resolvedGymId);
    }

    const now = new Date();
    await tx.gymLink.updateMany({
      where: { userId, removedAt: null },
      data: { removedAt: now },
    });
    await tx.gymLink.create({
      data: { userId, gymId: resolvedGymId, source: resolvedSource, linkedAt: now },
    });
    return tx.user.update({
      where: { id: userId },
      data: {
        linkedGymId: resolvedGymId,
        // Self-declared members must opt in before they show on the per-gym
        // attendance leaderboard — otherwise merely claiming a gym would expose
        // them next to named check-ins they never made.
        ...(resolvedSource === 'self' ? { leaderboardOptIn: false } : {}),
      },
    });
  });
}

async function assertSelfLinkAllowed(tx, userId, gymId) {
  // A gym that removed this person has blocked self-rejoin; only a physical
  // gym QR can bring them back.
  const blocked = await tx.gymLink.findFirst({
    where: { userId, gymId, removedAt: { not: null }, selfRelinkBlocked: true },
    select: { id: true },
  });
  if (blocked) {
    throw { status: 409, error: 'This gym removed you. Scan the gym QR to rejoin.', errorCode: 'SELF_LINK_BLOCKED' };
  }

  // Cooldown: at most one self-link per 30 days.
  const recent = await tx.gymLink.findFirst({
    where: { userId, source: 'self', linkedAt: { gte: new Date(Date.now() - SELF_LINK_COOLDOWN_MS) } },
    select: { id: true },
  });
  if (recent) {
    throw { status: 429, error: 'You can only self-link to a gym once a month.', errorCode: 'SELF_LINK_LIMIT' };
  }

  // Device limit: no more than 3 self-links across every account that has ever
  // used any install id this user has used.
  const devices = await tx.userDevice.findMany({ where: { userId }, select: { installId: true } });
  const installIds = devices.map((d) => d.installId);
  if (installIds.length) {
    const sharers = await tx.userDevice.findMany({
      where: { installId: { in: installIds } },
      select: { userId: true },
      distinct: ['userId'],
    });
    const userIds = sharers.map((s) => s.userId);
    if (userIds.length) {
      const selfLinks = await tx.gymLink.count({ where: { userId: { in: userIds }, source: 'self' } });
      if (selfLinks >= SELF_LINK_DEVICE_LIMIT) {
        throw { status: 429, error: 'Too many gym links from this device.', errorCode: 'SELF_LINK_LIMIT' };
      }
    }
  }
}

// Customer leaves their gym: close the link and clear the pointer. No re-link
// block — leaving is voluntary, unlike a partner removal.
export async function leaveGym(prisma, userId) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.gymLink.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now } });
    await tx.user.update({ where: { id: userId }, data: { linkedGymId: null } });
    return { ok: true };
  });
}

// Partner removes a member: close the link, block self-rejoin, clear the
// pointer, and drop a notice the app shows so the customer knows why their gym
// disappeared.
export async function removeMemberFromGym(prisma, gymId, userId, partnerId) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.gymLink.updateMany({
      where: { userId, gymId, removedAt: null },
      data: { removedAt: now, removedByPartnerId: partnerId, selfRelinkBlocked: true },
    });
    await tx.user.updateMany({
      where: { id: userId, linkedGymId: gymId },
      data: { linkedGymId: null, gymLinkNotice: 'removed_by_gym' },
    });
    return { ok: true };
  });
}

// A verified check-in (booking attended or gym check-in) qualifies a
// self-declared link: from here it is a real membership and shows in rosters /
// counts. Idempotent — only the first stamp writes.
export async function markGymCheckedIn(prisma, userId, gymId) {
  const active = await prisma.gymLink.findFirst({
    where: { userId, gymId, removedAt: null },
    orderBy: { linkedAt: 'desc' },
  });
  if (!active || active.firstVerifiedCheckinAt) return { ok: true };
  await prisma.gymLink.update({
    where: { id: active.id },
    data: { firstVerifiedCheckinAt: new Date() },
  });
  return { ok: true };
}

// Gym-service tells us an unclaimed gym was claimed by a partner: everyone who
// had it as their home unclaimed gym (or arrived through it) is prompted to
// move to the now-claimable gym.
export async function applyUnclaimedGymClaim(prisma, { unclaimedGymId, claimedGymId, customerIds }) {
  const resolvedClaimed = toPositiveInt(claimedGymId);
  if (!resolvedClaimed) {
    throw { status: 400, error: 'claimedGymId required' };
  }
  const resolvedUnclaimed = toPositiveInt(unclaimedGymId);
  const ids = Array.isArray(customerIds)
    ? customerIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];

  const or = [];
  if (ids.length) or.push({ id: { in: ids } });
  if (resolvedUnclaimed) or.push({ homeUnclaimedGymId: resolvedUnclaimed });
  if (!or.length) return { ok: true };

  await prisma.user.updateMany({
    where: { OR: or },
    data: { pendingGymPromptGymId: resolvedClaimed },
  });
  return { ok: true };
}
