import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { MATCH_EXPIRY_DAYS } from './buddyService.js';

const prisma = new PrismaClient();
const HEALTH_SERVICE_URL = process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

async function internalHeaders() {
  return {
    headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(HEALTH_SERVICE_URL)) },
  };
}

/**
 * Generates a consistency league for a user and their matches.
 */
export async function getConsistencyLeague(userId) {
  try {
    // 1. Get all active matches (buddies). Same read shape as getMatches:
    // only status='active' matches, and lazily hide ones expired by 30 days
    // of inactivity so the league never shows stale buddies.
    const expiryCutoff = new Date(Date.now() - MATCH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const matches = await prisma.match.findMany({
      where: {
        status: 'active',
        lastActivityAt: { gte: expiryCutoff },
        OR: [{ userLowId: userId }, { userHighId: userId }],
      },
    });

    const buddyIds = new Set();
    for (const match of matches) {
      const buddyId = match.userLowId === userId ? match.userHighId : match.userLowId;
      buddyIds.add(buddyId);
    }
    buddyIds.add(userId);

    const userList = Array.from(buddyIds);

    // 2. Fetch behavioral consistency from health-service
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
    console.error('getConsistencyLeague failed:', err.response?.status || err.message);
    throw new Error('Could not load consistency league');
  }
}
