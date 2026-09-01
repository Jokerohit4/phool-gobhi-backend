import { PrismaClient } from '@prisma/client';
import { MAX_CHALLENGE_DISTANCE_KM, distanceKmFromUser, isWithinMaxChallengeRange } from '../utils/location.js';

const prisma = new PrismaClient();

// Seed is additive and idempotent: existing rows are matched by
// (definition key, city) and only ever backfilled (coordinates) — never
// overwritten — so an admin's edits survive every redeploy, and new cities
// (Gorakhpur) are seeded into already-live databases instead of only into a
// fresh one. The original "return early when count > 0" guard was removed
// for exactly this reason: it made city expansion impossible without wiping
// the DB.
const OFF_PEAK_HUNTER_KEY = 'off_peak_hunter_v1';
const CITY_QUEST_GURUGRAM_KEY = 'city_explorer_quest_v1';
const CITY_QUEST_GORAKHPUR_KEY = 'city_explorer_quest_gorakhpur_v1';

// Per-city anchor + OFF_PEAK windows for the off-peak challenges.
const OFF_PEAK_WINDOWS = [
  { startHourIst: 6, endHourIst: 9 },
  { startHourIst: 14, endHourIst: 17 },
];

const GURUGRAM_CENTER = { lat: 28.4766, lng: 77.0841 };
const GORAKHPUR_CENTER = { lat: 26.7596, lng: 83.3727 };

// Gurugram checkpoint cluster (the pilot's original placeholders — real
// sticker locations are managed from the admin panel's check-point spots UI).
const SEED_QUEST_SPOTS_GURUGRAM = [
  { sequence: 1, label: 'Cyber Hub Gate', lat: 28.4949, lng: 77.0891, code: 'CKPT-CYBERHUB' },
  { sequence: 2, label: 'Sector 29 Market', lat: 28.4636, lng: 77.0730, code: 'CKPT-SECTOR29' },
  { sequence: 3, label: 'Kingdom of Dreams', lat: 28.4675, lng: 77.0693, code: 'CKPT-KOD' },
  { sequence: 4, label: 'Leisure Valley Park', lat: 28.4531, lng: 77.0925, code: 'CKPT-LEISUREVALLEY' },
  { sequence: 5, label: 'Ambience Mall', lat: 28.5039, lng: 77.0964, code: 'CKPT-AMBIENCE' },
];

// Gorakhpur checkpoint cluster — every spot is well inside the 20km radius
// of GorakHPUR_CENTER, so the whole quest is completable from the city.
const SEED_QUEST_SPOTS_GORAKHPUR = [
  { sequence: 1, label: 'Gorakhnath Temple', lat: 26.7601, lng: 83.3709, code: 'CKPT-GORAKHNATH' },
  { sequence: 2, label: 'Ramgarh Tal Lake', lat: 26.7860, lng: 83.3050, code: 'CKPT-RAMGARHTAL' },
  { sequence: 3, label: 'AIIMS Gorakhpur', lat: 26.7401, lng: 83.3880, code: 'CKPT-AIIMSGKP' },
  { sequence: 4, label: 'Gita Press', lat: 26.7584, lng: 83.3655, code: 'CKPT-GITAPRESS' },
  { sequence: 5, label: 'Gorakhpur Junction Station', lat: 26.7547, lng: 83.3752, code: 'CKPT-GKPJN' },
];

async function upsertDefinition(data) {
  const existing = await prisma.challengeDefinition.findUnique({ where: { key: data.key } });
  if (existing) return existing;
  return prisma.challengeDefinition.create({ data });
}

// Find-or-create a Challenge instance by (definition, city). Existing rows
// keep their admin-edited values; only a missing coordinate anchor is
// backfilled so pre-location databases become geo-eligible without a wipe.
// Quest checkpoint spots are created once by code; gaps are filled from the
// admin panel afterwards.
async function upsertChallenge({ definition, city, lat, lng, targetCount, rewardCoins, offPeakWindows, spots }) {
  const existing = await prisma.challenge.findFirst({
    where: { challengeDefinitionId: definition.id, city },
  });
  let challenge;
  if (!existing) {
    challenge = await prisma.challenge.create({
      data: {
        challengeDefinitionId: definition.id,
        city,
        targetCount,
        rewardCoins,
        lat,
        lng,
        offPeakWindows: offPeakWindows ?? null,
      },
    });
  } else {
    const backfill = {
      ...(existing.lat == null && lat != null ? { lat } : {}),
      ...(existing.lng == null && lng != null ? { lng } : {}),
    };
    challenge = Object.keys(backfill).length
      ? await prisma.challenge.update({ where: { id: existing.id }, data: backfill })
      : existing;
  }

  if (Array.isArray(spots) && spots.length) {
    const existingSpotCount = await prisma.challengeCheckpointSpot.count({ where: { challengeId: challenge.id } });
    if (existingSpotCount === 0) {
      await prisma.challengeCheckpointSpot.createMany({
        data: spots.map((s) => ({ ...s, challengeId: challenge.id })),
      });
    }
  }
  return challenge;
}

async function ensureSeeded() {
  const offPeakDef = await upsertDefinition({
    key: OFF_PEAK_HUNTER_KEY,
    type: 'off_peak_hunter',
    category: 'gym_native',
    title: 'Off-Peak Hunter',
    description: 'Check in during off-peak hours 5 times to earn coins.',
    defaultVerificationMethod: 'booking_attendance',
  });
  const gurugramQuestDef = await upsertDefinition({
    key: CITY_QUEST_GURUGRAM_KEY,
    type: 'poi_checkin_tour',
    category: 'outside_gym_city',
    title: 'Gurugram Explorer Quest',
    description: 'Visit every checkpoint sticker in the Gurugram cluster to earn coins.',
    defaultVerificationMethod: 'qr_scan',
    requiresGeofenceWithQr: true,
  });
  const gorakhpurQuestDef = await upsertDefinition({
    key: CITY_QUEST_GORAKHPUR_KEY,
    type: 'poi_checkin_tour',
    category: 'outside_gym_city',
    title: 'Gorakhpur Explorer Quest',
    description: 'Visit every checkpoint sticker in the Gorakhpur cluster to earn coins.',
    defaultVerificationMethod: 'qr_scan',
    requiresGeofenceWithQr: true,
  });

  await upsertChallenge({
    definition: offPeakDef,
    city: 'Gurugram',
    ...GURUGRAM_CENTER,
    targetCount: 5,
    rewardCoins: 150,
    offPeakWindows: OFF_PEAK_WINDOWS,
  });
  await upsertChallenge({
    definition: offPeakDef,
    city: 'Gorakhpur',
    ...GORAKHPUR_CENTER,
    targetCount: 5,
    rewardCoins: 150,
    offPeakWindows: OFF_PEAK_WINDOWS,
  });
  await upsertChallenge({
    definition: gurugramQuestDef,
    city: 'Gurugram',
    ...GURUGRAM_CENTER,
    targetCount: SEED_QUEST_SPOTS_GURUGRAM.length,
    rewardCoins: 200,
    spots: SEED_QUEST_SPOTS_GURUGRAM,
  });
  await upsertChallenge({
    definition: gorakhpurQuestDef,
    city: 'Gorakhpur',
    ...GORAKHPUR_CENTER,
    targetCount: SEED_QUEST_SPOTS_GORAKHPUR.length,
    rewardCoins: 200,
    spots: SEED_QUEST_SPOTS_GORAKHPUR,
  });
}

export async function listActiveChallengesService({ userId, userLat, userLng }) {
  await ensureSeeded();
  const challenges = await prisma.challenge.findMany({
    where: { status: 'active' },
    include: { challengeDefinition: true, enrollments: { where: { userId } } },
    orderBy: { id: 'asc' },
  });
  return challenges
    .map((challenge) => ({
      ...challenge,
      distanceKm: distanceKmFromUser(userLat, userLng, challenge),
    }))
    // The 20km radius is a hard rule, not a suggestion: no user location
    // (can't prove proximity) or no challenge anchor → excluded, exactly how
    // gym-service drops coordinate-less gyms once a location is attached.
    .filter((challenge) => challenge.distanceKm != null && challenge.distanceKm <= MAX_CHALLENGE_DISTANCE_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map(serializeChallenge);
}

export async function getChallengeDetailService(challengeId, { userId, userLat, userLng }) {
  const challenge = await prisma.challenge.findUnique({
    where: { id: Number(challengeId) },
    include: {
      challengeDefinition: true,
      enrollments: { where: { userId } },
      checkpointSpots: { orderBy: { sequence: 'asc' } },
    },
  });
  if (!challenge) throw { status: 404, error: 'Challenge not found' };
  // Same geo-gate as the list: an out-of-range challenge — or one that can't
  // be proven within range (no anchor / no user location) — is treated as
  // non-existent, so the detail route can't enumerate far-away challenges.
  if (!isWithinMaxChallengeRange(userLat, userLng, challenge)) {
    throw { status: 404, error: 'Challenge not found' };
  }
  const enrollment = challenge.enrollments[0] || null;
  return {
    ...serializeChallenge({ ...challenge, distanceKm: distanceKmFromUser(userLat, userLng, challenge) }),
    checkpointSpots: challenge.checkpointSpots.map((s) => ({
      id: s.id, sequence: s.sequence, label: s.label, lat: s.lat, lng: s.lng,
    })),
    myVisitedSpotIds: enrollment
      ? (await prisma.challengeCheckpointVisit.findMany({
          where: { enrollmentId: enrollment.id },
          select: { checkpointSpotId: true },
        })).map((v) => v.checkpointSpotId)
      : [],
  };
}

function serializeChallenge(challenge) {
  const enrollment = challenge.enrollments?.[0] || null;
  return {
    id: challenge.id,
    key: challenge.challengeDefinition.key,
    type: challenge.challengeDefinition.type,
    category: challenge.challengeDefinition.category,
    title: challenge.challengeDefinition.title,
    description: challenge.challengeDefinition.description,
    verificationMethod: challenge.challengeDefinition.defaultVerificationMethod,
    city: challenge.city,
    lat: challenge.lat,
    lng: challenge.lng,
    distanceKm: challenge.distanceKm ?? null,
    targetCount: challenge.targetCount,
    rewardCoins: challenge.rewardCoins,
    myEnrollment: enrollment
      ? { status: enrollment.status, progressCount: enrollment.progressCount, completedAt: enrollment.completedAt }
      : null,
  };
}