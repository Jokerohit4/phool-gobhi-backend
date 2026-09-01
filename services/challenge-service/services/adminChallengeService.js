import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// A challenge without an anchor coordinate can never be shown or joined (the
// 20km radius requires one — see utils/location.js). The admin form accepts
// a city-center anchor; anything supplied here is validated so garbage
// coordinates never reach the DB, and creators are told the challenge stays
// hidden until an anchor exists.
function validateCoordinates(lat, lng) {
  if (lat === undefined && lng === undefined) return;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw { status: 400, error: 'lat and lng must be valid numbers' };
  }
  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
    throw { status: 400, error: 'lat/lng are out of range' };
  }
}

export async function listChallengeDefinitionsAdminService() {
  return prisma.challengeDefinition.findMany({ orderBy: { id: 'asc' } });
}

export async function createChallengeDefinitionAdminService(data) {
  const { key, type, category, title, description, defaultVerificationMethod, requiresGeofenceWithQr } = data;
  if (!key || !type || !category || !title || !defaultVerificationMethod) {
    throw { status: 400, error: 'key, type, category, title and defaultVerificationMethod are required' };
  }
  return prisma.challengeDefinition.create({
    data: { key, type, category, title, description: description ?? null, defaultVerificationMethod, requiresGeofenceWithQr: !!requiresGeofenceWithQr },
  });
}

export async function listChallengesAdminService() {
  return prisma.challenge.findMany({
    include: { challengeDefinition: true, checkpointSpots: true, _count: { select: { enrollments: true } } },
    orderBy: { id: 'asc' },
  });
}

export async function createChallengeAdminService(data) {
  const { challengeDefinitionId, city, targetCount, rewardCoins, offPeakWindows, sponsorId, lat, lng } = data;
  if (!challengeDefinitionId || !city || !Number.isInteger(targetCount) || targetCount <= 0 || !Number.isInteger(rewardCoins) || rewardCoins < 0) {
    throw { status: 400, error: 'challengeDefinitionId, city, a positive targetCount and a non-negative rewardCoins are required' };
  }
  validateCoordinates(lat, lng);
  return prisma.challenge.create({
    data: {
      challengeDefinitionId: Number(challengeDefinitionId), city, targetCount, rewardCoins,
      offPeakWindows: offPeakWindows ?? null, sponsorId: sponsorId ?? null,
      lat: lat === undefined ? null : Number(lat),
      lng: lng === undefined ? null : Number(lng),
    },
  });
}

export async function updateChallengeAdminService(id, data) {
  const existing = await prisma.challenge.findUnique({ where: { id: Number(id) } });
  if (!existing) throw { status: 404, error: 'Challenge not found' };
  const { status, targetCount, rewardCoins, offPeakWindows, endsAt, lat, lng } = data;
  validateCoordinates(lat, lng);
  return prisma.challenge.update({
    where: { id: Number(id) },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(targetCount !== undefined ? { targetCount: Number(targetCount) } : {}),
      ...(rewardCoins !== undefined ? { rewardCoins: Number(rewardCoins) } : {}),
      ...(offPeakWindows !== undefined ? { offPeakWindows } : {}),
      ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
      ...(lat !== undefined ? { lat: lat === null ? null : Number(lat) } : {}),
      ...(lng !== undefined ? { lng: lng === null ? null : Number(lng) } : {}),
    },
  });
}

export async function listCheckpointSpotsAdminService(challengeId) {
  return prisma.challengeCheckpointSpot.findMany({ where: { challengeId: Number(challengeId) }, orderBy: { sequence: 'asc' } });
}

export async function createCheckpointSpotAdminService(challengeId, data) {
  const { sequence, label, lat, lng, radiusMeters, code } = data;
  if (!label || typeof lat !== 'number' || typeof lng !== 'number' || !code) {
    throw { status: 400, error: 'label, lat, lng and code are required' };
  }
  return prisma.challengeCheckpointSpot.create({
    data: {
      challengeId: Number(challengeId),
      sequence: sequence ?? 0,
      label, lat, lng,
      radiusMeters: radiusMeters ?? 75,
      code,
    },
  });
}

export async function listEnrollmentsAdminService(challengeId) {
  return prisma.challengeEnrollment.findMany({
    where: { challengeId: Number(challengeId) },
    orderBy: { startedAt: 'desc' },
    take: 200,
  });
}

export async function listSponsorsAdminService() {
  return prisma.sponsor.findMany({ orderBy: { id: 'asc' } });
}

export async function createSponsorAdminService({ type, name, contactInfo }) {
  if (!type || !name) throw { status: 400, error: 'type and name are required' };
  return prisma.sponsor.create({ data: { type, name, contactInfo: contactInfo ?? null } });
}
