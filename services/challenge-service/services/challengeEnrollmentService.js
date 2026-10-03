import { PrismaClient } from '@prisma/client';
import { creditCoinsService } from './coinLedgerService.js';
import { isWithinMaxChallengeRange } from '../utils/location.js';
import { track } from '../utils/analytics.js';
const prisma = new PrismaClient();

// Same haversine formula as booking-service's self-check-in geofence check
// — duplicated per-service by this repo's own convention (see e.g.
// utils/googleIdToken.js), not shared, since these are independent services.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fixed +5:30 offset, same convention as the rest of this backend's
// IST-hardcoding (no timezone library dependency) — returns the IST hour
// (0-23) of a UTC instant.
function istHour(date) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(new Date(date).getTime() + IST_OFFSET_MS).getUTCHours();
}

function inOffPeakWindow(attendedAt, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const hour = istHour(attendedAt);
  return windows.some((w) => hour >= w.startHourIst && hour < w.endHourIst);
}

async function completeAndReward(enrollment, challenge, via) {
  const updated = await prisma.challengeEnrollment.update({
    where: { id: enrollment.id },
    data: { status: 'completed', completedAt: new Date() },
  });
  if (challenge.rewardCoins > 0) {
    await creditCoinsService(
      enrollment.userId, challenge.rewardCoins, `Completed challenge: ${challenge.id}`,
      `challenge-reward:${enrollment.id}`,
    );
  }
  await prisma.rewardIssuance.upsert({
    where: { enrollmentId: enrollment.id },
    update: {},
    create: { enrollmentId: enrollment.id, rewardType: 'coins', coinAmount: challenge.rewardCoins },
  });
  track('challenge_completed', enrollment.userId, {
    challenge_id: challenge.id,
    progress_count: updated.progressCount,
    target_count: challenge.targetCount,
    reward_coins: challenge.rewardCoins,
    via,
  });
  return updated;
}

export async function enrollService(userId, challengeId, { userLat, userLng } = {}) {
  const challenge = await prisma.challenge.findUnique({ where: { id: Number(challengeId) } });
  if (!challenge || challenge.status !== 'active') throw { status: 404, error: 'Challenge not found or inactive' };

  // Location gate — the 20km radius is enforced at enrollment too, so the
  // list filter can't be bypassed by deep-linking a far challenge's id. Fails
  // closed: no location headers (client hasn't shared/resolved GPS) or no
  // challenge anchor both reject rather than assume in-range.
  if (userLat == null || userLng == null) {
    throw { status: 400, error: 'Location is required to join this challenge' };
  }
  if (!isWithinMaxChallengeRange(userLat, userLng, challenge)) {
    throw { status: 403, error: 'This challenge is only available within 20km of your location' };
  }

  const existing = await prisma.challengeEnrollment.findUnique({
    where: { userId_challengeId: { userId, challengeId: challenge.id } },
  });
  if (existing) {
    track('challenge_enrolled', userId, {
      challenge_id: challenge.id, already_enrolled: true,
      target_count: challenge.targetCount, reward_coins: challenge.rewardCoins,
    });
    return existing;
  }

  const created = await prisma.challengeEnrollment.create({ data: { userId, challengeId: challenge.id } });
  track('challenge_enrolled', userId, {
    challenge_id: challenge.id, already_enrolled: false,
    target_count: challenge.targetCount, reward_coins: challenge.rewardCoins,
  });
  return created;
}

export async function getMyEnrollmentService(userId, challengeId) {
  return prisma.challengeEnrollment.findUnique({
    where: { userId_challengeId: { userId, challengeId: Number(challengeId) } },
  });
}

// Customer-facing "leave challenge". Only an 'active' enrollment can be left:
// a 'completed' (or already 'abandoned') enrollment is a legal no-op that
// returns the row unchanged — the same non-action convention
// visitCheckpointService uses for non-active enrollments, so the call never
// errors on a record we don't own. Marks the row 'abandoned' rather than
// deleting it: keeps visit/reward history for admin analytics and preserves
// the (userId, challengeId) uniqueness so the app never re-enrolls into a
// phantom. (Note: enrollService currently returns any existing row as-is, so
// re-joining after leaving returns the abandoned record — a deliberate future
// decision point, not addressed here.)
export async function leaveChallengeService(userId, challengeId) {
  const enrollment = await prisma.challengeEnrollment.findUnique({
    where: { userId_challengeId: { userId, challengeId: Number(challengeId) } },
  });
  if (!enrollment) throw { status: 400, error: 'Enroll in this challenge first' };
  if (enrollment.status !== 'active') {
    track('challenge_left', userId, {
      challenge_id: Number(challengeId), prior_status: enrollment.status, abandoned: false,
    });
    return enrollment;
  }
  const updated = await prisma.challengeEnrollment.update({
    where: { id: enrollment.id },
    data: { status: 'abandoned' },
  });
  track('challenge_left', userId, {
    challenge_id: Number(challengeId), prior_status: 'active', abandoned: true,
    progress_count: updated.progressCount,
  });
  return updated;
}

// Called from the customer-facing checkpoint endpoint for outside_gym_city
// quests. Verifies the code matches a real spot on this challenge AND the
// customer's GPS is within that spot's radius — both conditions together
// are the anti-replay defense (see schema comment): a photographed sticker
// scanned from home fails the GPS check even with a valid code.
export async function visitCheckpointService(userId, challengeId, { code, lat, lng }) {
  const enrollment = await prisma.challengeEnrollment.findUnique({
    where: { userId_challengeId: { userId, challengeId: Number(challengeId) } },
    include: { challenge: true },
  });
  if (!enrollment) throw { status: 400, error: 'Enroll in this challenge first' };
  if (enrollment.status !== 'active') {
    track('challenge_checkpoint_visited', userId, {
      challenge_id: Number(challengeId), replayed: false, accepted: false,
      reason: 'enrollment_not_active', progress_after: enrollment.progressCount,
    });
    return enrollment;
  }

  const spot = await prisma.challengeCheckpointSpot.findUnique({ where: { code } });
  if (!spot || spot.challengeId !== enrollment.challengeId) {
    throw { status: 404, error: 'Unknown checkpoint code for this challenge' };
  }

  const alreadyVisited = await prisma.challengeCheckpointVisit.findUnique({
    where: { enrollmentId_checkpointSpotId: { enrollmentId: enrollment.id, checkpointSpotId: spot.id } },
  });
  if (alreadyVisited) {
    track('challenge_checkpoint_visited', userId, {
      challenge_id: Number(challengeId), replayed: true, accepted: false,
      reason: 'already_visited', progress_after: enrollment.progressCount,
    });
    return enrollment;
  }

  const distance = distanceMeters(lat, lng, spot.lat, spot.lng);
  if (distance > spot.radiusMeters) {
    throw { status: 400, error: `You're too far from ${spot.label} to check in here`, code: 'TOO_FAR', distance: Math.round(distance) };
  }

  await prisma.challengeCheckpointVisit.create({
    data: { enrollmentId: enrollment.id, checkpointSpotId: spot.id, lat, lng },
  });
  const updated = await prisma.challengeEnrollment.update({
    where: { id: enrollment.id },
    data: { progressCount: { increment: 1 } },
  });

  const completed = updated.progressCount >= enrollment.challenge.targetCount;
  track('challenge_checkpoint_visited', userId, {
    challenge_id: enrollment.challengeId, replayed: false, accepted: true,
    reason: null, progress_after: updated.progressCount,
    target_count: enrollment.challenge.targetCount, completed,
  });

  if (completed) {
    return completeAndReward(updated, enrollment.challenge, 'checkpoint');
  }
  return updated;
}

// Called internally from the attendance-events hook (booking-service ->
// challenge-service) for every gym_native/off_peak_hunter challenge the user
// is actively enrolled in. A no-op if the attendance falls outside every
// configured off-peak window, or the user isn't enrolled in any such
// challenge — this is intentionally cheap to call on every check-in.
export async function advanceOffPeakChallengesService(userId, attendedAt) {
  const enrollments = await prisma.challengeEnrollment.findMany({
    where: { userId, status: 'active', challenge: { challengeDefinition: { type: 'off_peak_hunter' } } },
    include: { challenge: true },
  });
  let advanced = 0;
  let completedCount = 0;
  for (const enrollment of enrollments) {
    if (!inOffPeakWindow(attendedAt, enrollment.challenge.offPeakWindows)) continue;
    const updated = await prisma.challengeEnrollment.update({
      where: { id: enrollment.id },
      data: { progressCount: { increment: 1 } },
    });
    advanced += 1;
    if (updated.progressCount >= enrollment.challenge.targetCount) {
      completedCount += 1;
      await completeAndReward(updated, enrollment.challenge, 'off_peak');
    }
  }
  if (advanced > 0) {
    track('challenge_off_peak_advanced', userId, {
      challenge_count: advanced, completed_count: completedCount,
    });
  }
}
