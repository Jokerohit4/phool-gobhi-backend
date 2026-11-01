import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { MATCH_EXPIRY_DAYS } from './buddyService.js';
import { getUsersBatchInternal } from './authClient.js';

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
    // The health scores and the display-name lookup are independent, so they
    // run together. The name lookup is best-effort (below) and must never
    // reject, so a health failure still fails the league exactly as before.
    const namesPromise = getUsersBatchInternal(userList).catch(() => []);
    const scoresPromise = (async () => {
      const res = await axios.post(
        `${HEALTH_SERVICE_URL}/internal/ledger/biometrics/batch-consistency`,
        { userIds: userList },
        { ...(await internalHeaders()), timeout: 3000 }
      );
      return res.data.data || [];
    })();
    const [scores, userInfos] = await Promise.all([scoresPromise, namesPromise]);

    // Display names come from auth-service's batch lookup — BuddyProfile has
    // no `name`/`displayName` column, so the old `profile?.displayName`
    // fallback rendered every row (including the caller's own) as
    // "Unknown Buddy". Best-effort like elsewhere in the service: a lookup
    // failure degrades to the fallback rather than failing the league.
    // (A lookup failure was already mapped to [] above.)
    const nameById = new Map(userInfos.map((u) => [u.id, u.name]));

    // Build from the full buddy set, not just the scored rows: users with no
    // biometric snapshots in the 7-day window (new/light users) were omitted
    // entirely, which zeroed their own myRank and undercounted
    // totalParticipants. Scored users sort by score; unscored ones sink to
    // the bottom with score 0.
    const scoreByUserId = new Map(scores.map((s) => [s.userId, s]));
    const league = userList.map((uid) => {
      const s = scoreByUserId.get(uid);
      return {
        userId: uid,
        name: nameById.get(uid) || 'Buddy',
        // null = fewer than four closed days: ranks like no data.
        score: s?.avgScore ?? 0,
        isMe: uid === userId,
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
