import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Manages collaborative health challenges between buddies.
 * A challenge is a shared goal (e.g., "14-day Step Challenge") 
 * that multiple buddies commit to.
 */
export async function createCollaborativeChallenge({
  initiatorId,
  targetUserId,
  challengeType,
  durationDays = 14,
}) {
  return await prisma.$transaction(async (tx) => {
    // 1. Create the Challenge header
    const challenge = await tx.healthChallenge.create({
      data: {
        type: challengeType,
        durationDays,
        status: 'active',
        startedAt: new Date(),
        createdAt: new Date(),
      },
    });

    // 2. Link participants
    await tx.challengeParticipant.createMany({
      data: [
        { challengeId: challenge.id, userId: initiatorId, role: 'initiator' },
        { challengeId: challenge.id, userId: targetUserId, role: 'participant' },
      ],
    });

    return challenge;
  });
}

export async function getActiveChallenges(userId) {
  return await prisma.healthChallenge.findMany({
    where: {
      status: 'active',
      participants: {
        some: { userId },
      },
    },
    include: {
      participants: {
        include: {
          user: {
            select: { displayName: true },
          },
        },
      },
    },
  });
}

export async function updateChallengeProgress(challengeId, userId, value) {
  return await prisma.challengeProgress.upsert({
    where: {
      challenge_userId: { challengeId, userId },
    },
    update: {
      currentValue: { increment: value },
      updatedAt: new Date(),
    },
    create: {
      challengeId,
      userId,
      currentValue: value,
    },
  });
}
