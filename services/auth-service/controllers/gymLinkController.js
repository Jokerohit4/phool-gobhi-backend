// Gym-link HTTP layer (coach-journey B2). Thin: parse, guard, delegate to
// services/gymLinkService.js, shape the response. Owns the Prisma client so
// tests can inject an in-memory double (same pattern as deviceController.js).

import prisma from '../db/prisma.js';
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
  listPendingSelfLinks,
  approveSelfLink,
  rejectSelfLink,
} from '../services/gymLinkService.js';
import { assertPartnerOwnsGym, fetchGymInternal } from '../services/authService.js';
import { notifyUser } from '../utils/notifyUser.js';
import { gymLinkStatus } from '../utils/gymLinkStatus.js';


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
    // The link is live straight away; `status` tells the app whether the gym has
    // confirmed it yet so it can say "waiting for <gym>" instead of "verified".
    const confirmed = gymLinkStatus(link) === 'approved';
    res.json({
      link: link
        ? {
            gymId: link.gymId,
            source: link.source,
            linkedAt: link.linkedAt,
            status: confirmed ? 'approved' : 'pending',
          }
        : { gymId, source: 'self', linkedAt: null, status: 'pending' },
    });
    // Only a link this call just created is news to the gym; a repeat call from
    // an already-linked user (first link wins) must not re-ping the owner.
    if (link && link.gymId === gymId && !confirmed && Date.now() - new Date(link.linkedAt).getTime() < 60_000) {
      void notifyGymOfLinkRequest(gymId);
    }
  } catch (err) {
    fail(res, err);
  }
};

// Best-effort push to the gym owner that someone claimed membership. Never
// throws: a missed push must not fail the customer's link. The body carries no
// customer name — the gym reads that in the queue, behind their own login.
async function notifyGymOfLinkRequest(gymId) {
  try {
    const gym = await fetchGymInternal(gymId);
    if (!gym?.partnerId) return;
    const partner = await prisma.user.findUnique({
      where: { id: gym.partnerId },
      select: { fcmToken: true },
    });
    await notifyUser(partner?.fcmToken, {
      title: 'New member request',
      body: 'Someone says they train at your gym. Review and confirm.',
      data: { type: 'gym_link_request', gymId },
    });
  } catch (err) {
    console.error('[gym-link] notify gym failed:', err?.message || err);
  }
}

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

// Shared guard for the three partner link-request routes. Not flag-gated: a gym
// must always be able to see and answer claims already made in its name.
async function partnerGymParams(req) {
  if (req.user?.role !== 'partner') throw { status: 403, error: 'Forbidden' };
  const gymId = parseInt(req.params.gymId);
  if (!Number.isInteger(gymId) || gymId <= 0) throw { status: 400, error: 'gymId required' };
  await assertPartnerOwnsGym(gymId, req.user.id);
  const rawUserId = req.params.userId;
  if (rawUserId === undefined) return { gymId };
  const userId = parseInt(rawUserId);
  if (!Number.isInteger(userId) || userId <= 0) throw { status: 400, error: 'userId required' };
  return { gymId, userId };
}

// GET /gym/:gymId/link-requests — the gym's pending self-link queue.
export const listLinkRequests = async (req, res) => {
  try {
    const { gymId } = await partnerGymParams(req);
    res.json({ data: await listPendingSelfLinks(prisma, gymId) });
  } catch (err) {
    fail(res, err);
  }
};

// POST /gym/:gymId/link-requests/:userId/approve — confirm a self-declared member.
export const approveLinkRequest = async (req, res) => {
  try {
    const { gymId, userId } = await partnerGymParams(req);
    await approveSelfLink(prisma, gymId, userId, req.user.id);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
};

// POST /gym/:gymId/link-requests/:userId/reject — decline a pending claim.
export const rejectLinkRequest = async (req, res) => {
  try {
    const { gymId, userId } = await partnerGymParams(req);
    await rejectSelfLink(prisma, gymId, userId, req.user.id);
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
