import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Seeded once, only if no ChallengeDefinition exists yet — the docs' own
// Phase-0 gate for this pilot: exactly 2 free challenges, one gym-native,
// one outside-gym. Gurugram placeholder coordinates for the quest spots;
// swap for real pilot locations from the admin panel before launch.
const OFF_PEAK_HUNTER_KEY = 'off_peak_hunter_v1';
const CITY_QUEST_KEY = 'city_explorer_quest_v1';

const SEED_QUEST_SPOTS = [
  { sequence: 1, label: 'Cyber Hub Gate', lat: 28.4949, lng: 77.0891, code: 'CKPT-CYBERHUB' },
  { sequence: 2, label: 'Sector 29 Market', lat: 28.4636, lng: 77.0730, code: 'CKPT-SECTOR29' },
  { sequence: 3, label: 'Kingdom of Dreams', lat: 28.4675, lng: 77.0693, code: 'CKPT-KOD' },
  { sequence: 4, label: 'Leisure Valley Park', lat: 28.4531, lng: 77.0925, code: 'CKPT-LEISUREVALLEY' },
  { sequence: 5, label: 'Ambience Mall', lat: 28.5039, lng: 77.0964, code: 'CKPT-AMBIENCE' },
];

async function ensureSeeded() {
  const count = await prisma.challengeDefinition.count();
  if (count > 0) return;

  const offPeak = await prisma.challengeDefinition.create({
    data: {
      key: OFF_PEAK_HUNTER_KEY,
      type: 'off_peak_hunter',
      category: 'gym_native',
      title: 'Off-Peak Hunter',
      description: 'Check in during off-peak hours 5 times to earn coins.',
      defaultVerificationMethod: 'booking_attendance',
    },
  });
  await prisma.challenge.create({
    data: {
      challengeDefinitionId: offPeak.id,
      city: 'Gurugram',
      targetCount: 5,
      rewardCoins: 150,
      // 24h IST windows an attendance must fall inside to count — strawman,
      // admin-editable via PUT /admin/challenges/:id.
      offPeakWindows: [{ startHourIst: 6, endHourIst: 9 }, { startHourIst: 14, endHourIst: 17 }],
    },
  });

  const quest = await prisma.challengeDefinition.create({
    data: {
      key: CITY_QUEST_KEY,
      type: 'poi_checkin_tour',
      category: 'outside_gym_city',
      title: 'Gurugram Explorer Quest',
      description: 'Visit every checkpoint sticker in the pilot cluster to earn coins.',
      defaultVerificationMethod: 'qr_scan',
      requiresGeofenceWithQr: true,
    },
  });
  const questChallenge = await prisma.challenge.create({
    data: {
      challengeDefinitionId: quest.id,
      city: 'Gurugram',
      targetCount: SEED_QUEST_SPOTS.length,
      rewardCoins: 200,
    },
  });
  await prisma.challengeCheckpointSpot.createMany({
    data: SEED_QUEST_SPOTS.map((s) => ({ ...s, challengeId: questChallenge.id })),
  });
}

export async function listActiveChallengesService(userId) {
  await ensureSeeded();
  const challenges = await prisma.challenge.findMany({
    where: { status: 'active' },
    include: { challengeDefinition: true, enrollments: { where: { userId } } },
    orderBy: { id: 'asc' },
  });
  return challenges.map(serializeChallenge);
}

export async function getChallengeDetailService(challengeId, userId) {
  const challenge = await prisma.challenge.findUnique({
    where: { id: Number(challengeId) },
    include: {
      challengeDefinition: true,
      enrollments: { where: { userId } },
      checkpointSpots: { orderBy: { sequence: 'asc' } },
    },
  });
  if (!challenge) throw { status: 404, error: 'Challenge not found' };
  const enrollment = challenge.enrollments[0] || null;
  return {
    ...serializeChallenge(challenge),
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
    targetCount: challenge.targetCount,
    rewardCoins: challenge.rewardCoins,
    myEnrollment: enrollment
      ? { status: enrollment.status, progressCount: enrollment.progressCount, completedAt: enrollment.completedAt }
      : null,
  };
}
