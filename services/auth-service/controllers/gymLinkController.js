// Gym-link HTTP layer (coach-journey B2). Thin: parse, guard, delegate to
// services/gymLinkService.js, shape the response. Owns the Prisma client so
// tests can inject an in-memory double (same pattern as deviceController.js).

import { PrismaClient } from '@prisma/client';
import {
  linkGym,
  leaveGym,
  removeMemberFromGym,
  markGymCheckedIn,
  applyUnclaimedGymClaim,
  isSelfLinkGymEnabled,
  getActiveLink,
  acceptClaimPrompt,
  dismissClaimPrompt,
} from '../services/gymLinkService.js';
import { assertPartnerOwnsGym } from '../services/authService.js';

const prisma = new PrismaClient();

function requesterId(req) {
  const id = Number(req.user?.id ?? req.headers['x-user-id']);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(res, err) {
  res.status(err.status || 500).json({
    error: err.error || err.message || 'Server error',
    ...(err.errorCode ? { code: err.errorCode } : {}),
  });
}

// POST /gym-links/self — customer self-declares a gym. Flag-gated.
export const selfLink = async (req, res) => {
  try {
    const userId = requesterId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await isSelfLinkGymEnabled(prisma))) {
      return res.status(403).json({ error: 'Self-linking is not available', code: 'FLAG_DISABLED' });
    }
    const gymId = Number(req.body?.gymId);
    if (!Number.isInteger(gymId) || gymId <= 0) {
      return res.status(400).json({ error: 'gymId required' });
    }

    const user = await linkGym(prisma, userId, gymId, 'self');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const link = await getActiveLink(prisma, userId);
    res.json({
      link: link
        ? { gymId: link.gymId, source: link.source, linkedAt: link.linkedAt }
        : { gymId, source: 'self', linkedAt: null },
    });
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /gym-links/self — customer leaves their gym. Flag-gated.
export const leaveGymLink = async (req, res) => {
  try {
    const userId = requesterId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await isSelfLinkGymEnabled(prisma))) {
      return res.status(403).json({ error: 'Self-linking is not available', code: 'FLAG_DISABLED' });
    }
    await leaveGym(prisma, userId);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /gym/:gymId/members/:userId — partner removes a member. Not flag-gated
// (a gym must always be able to remove someone it says it didn't join).
export const removeGymMember = async (req, res) => {
  try {
    if (req.user?.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const gymId = parseInt(req.params.gymId);
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(gymId) || !Number.isInteger(userId)) {
      return res.status(400).json({ error: 'gymId and userId required' });
    }
    await assertPartnerOwnsGym(gymId, req.user.id);
    await removeMemberFromGym(prisma, gymId, userId, req.user.id);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
};

// POST /me/notice/clear — customer dismisses the "your gym removed you" notice.
export const clearGymLinkNotice = async (req, res) => {
  try {
    const userId = requesterId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    await prisma.user.updateMany({ where: { id: userId }, data: { gymLinkNotice: null } });
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
};

// POST /internal/gym-links/checked-in — booking-service pings after an
// attended booking or a member check-in to stamp the link's first verified
// check-in (fire-and-forget on the caller's side).
export const gymLinkCheckedIn = async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    const gymId = Number(req.body?.gymId);
    if (!Number.isInteger(userId) || !Number.isInteger(gymId)) {
      return res.status(400).json({ error: 'userId and gymId required' });
    }
    await markGymCheckedIn(prisma, userId, gymId);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
};

// POST /internal/unclaimed-gym-claimed — gym-service tells us an unclaimed gym
// was claimed; prompt its customers toward the real gym.
export const unclaimedGymClaimed = async (req, res) => {
  try {
    await applyUnclaimedGymClaim(prisma, req.body ?? {});
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
};

// POST /gym-links/claim-prompt/accept — link to the gym the "your gym just
// joined" prompt points at. 200 { linkedGymId }.
export const acceptGymClaimPrompt = async (req, res) => {
  try {
    const userId = requesterId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = await acceptClaimPrompt(prisma, userId);
    res.json({ linkedGymId: user.linkedGymId ?? null });
  } catch (err) {
    fail(res, err);
  }
};

// POST /gym-links/claim-prompt/dismiss — "Not now". 204.
export const dismissGymClaimPrompt = async (req, res) => {
  try {
    const userId = requesterId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    await dismissClaimPrompt(prisma, userId);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
};
