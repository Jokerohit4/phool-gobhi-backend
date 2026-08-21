import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

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
  const { challengeDefinitionId, city, targetCount, rewardCoins, offPeakWindows, sponsorId } = data;
  if (!challengeDefinitionId || !city || !Number.isInteger(targetCount) || targetCount <= 0 || !Number.isInteger(rewardCoins) || rewardCoins < 0) {
    throw { status: 400, error: 'challengeDefinitionId, city, a positive targetCount and a non-negative rewardCoins are required' };
  }
  return prisma.challenge.create({
    data: { challengeDefinitionId: Number(challengeDefinitionId), city, targetCount, rewardCoins, offPeakWindows: offPeakWindows ?? null, sponsorId: sponsorId ?? null },
  });
}

export async function updateChallengeAdminService(id, data) {
  const existing = await prisma.challenge.findUnique({ where: { id: Number(id) } });
  if (!existing) throw { status: 404, error: 'Challenge not found' };
  const { status, targetCount, rewardCoins, offPeakWindows, endsAt } = data;
  return prisma.challenge.update({
    where: { id: Number(id) },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(targetCount !== undefined ? { targetCount: Number(targetCount) } : {}),
      ...(rewardCoins !== undefined ? { rewardCoins: Number(rewardCoins) } : {}),
      ...(offPeakWindows !== undefined ? { offPeakWindows } : {}),
      ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
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
