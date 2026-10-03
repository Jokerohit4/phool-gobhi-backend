import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();
const HEALTH_SERVICE_URL = process.env.HEALTH_SERVICE_URL || 'http://health-service:5002';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

async function internalHeaders() {
  return { headers: { 'x-internal-key': INTERNAL_API_KEY } };
}

/**
 * Generates a consistency league for a user and their matches.
 */
export async function getConsistencyLeague(userId) {
  // 1. Get all active matches (buddies)
  const matches = await prisma.match.findMany({
    where: {
      OR: [{ userId: userId }, { targetUserId: userId }],
    },
    include: {
      user: true,
      targetUser: true,
    },
  });

  const buddyIds = new Set();
  for (const match of matches) {
    const buddyId = match.userId === userId ? match.targetUserId : match.userId;
    buddyIds.add(buddyId);
  }
  buddyIds.add(userId);

  const userList = Array.from(buddyIds);

  // 2. Fetch behavioral consistency from health-service
  try {
    const res = await axios.post(
      `${HEALTH_SERVICE_URL}/internal/ledger/biometrics/batch-consistency`,
      { userIds: userList },
      await internalHeaders()
    );

    const scores = res.data.data || [];
    
    // 3. Map scores to user profiles
    const profiles = await prisma.buddyProfile.findMany({
      where: { userId: { in: userList } },
    });

    const league = scores.map(s => {
      const profile = profiles.find(p => p.userId === s.userId);
      return {
        userId: s.userId,
        name: profile?.displayName || 'Unknown Buddy',
        score: s.avgScore,
        isMe: s.userId === userId,
      };
    }).sort((a, b) => b.score - a.score);

    return {
      league,
      myRank: league.findIndex(u => u.isMe) + 1,
      totalParticipants: league.length,
    };
  } catch (err) {
    console.error('getConsistencyLeague failed:', err.message);
    throw new Error('Could not load consistency league');
  }
}
