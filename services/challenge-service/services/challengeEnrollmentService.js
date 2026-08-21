import { PrismaClient } from '@prisma/client';
import { creditCoinsService } from './coinLedgerService.js';
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

async function completeAndReward(enrollment, challenge) {
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
  return updated;
}

export async function enrollService(userId, challengeId) {
  const challenge = await prisma.challenge.findUnique({ where: { id: Number(challengeId) } });
  if (!challenge || challenge.status !== 'active') throw { status: 404, error: 'Challenge not found or inactive' };

  const existing = await prisma.challengeEnrollment.findUnique({
    where: { userId_challengeId: { userId, challengeId: challenge.id } },
  });
  if (existing) return existing;

  return prisma.challengeEnrollment.create({ data: { userId, challengeId: challenge.id } });
}

export async function getMyEnrollmentService(userId, challengeId) {
  return prisma.challengeEnrollment.findUnique({
    where: { userId_challengeId: { userId, challengeId: Number(challengeId) } },
  });
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
  if (enrollment.status !== 'active') return enrollment;

  const spot = await prisma.challengeCheckpointSpot.findUnique({ where: { code } });
  if (!spot || spot.challengeId !== enrollment.challengeId) {
    throw { status: 404, error: 'Unknown checkpoint code for this challenge' };
  }

  const alreadyVisited = await prisma.challengeCheckpointVisit.findUnique({
    where: { enrollmentId_checkpointSpotId: { enrollmentId: enrollment.id, checkpointSpotId: spot.id } },
  });
  if (alreadyVisited) return enrollment;

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

  if (updated.progressCount >= enrollment.challenge.targetCount) {
    return completeAndReward(updated, enrollment.challenge);
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
  for (const enrollment of enrollments) {
    if (!inOffPeakWindow(attendedAt, enrollment.challenge.offPeakWindows)) continue;
    const updated = await prisma.challengeEnrollment.update({
      where: { id: enrollment.id },
      data: { progressCount: { increment: 1 } },
    });
    if (updated.progressCount >= enrollment.challenge.targetCount) {
      await completeAndReward(updated, enrollment.challenge);
    }
  }
}
