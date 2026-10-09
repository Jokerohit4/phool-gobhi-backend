import { PrismaClient } from '@prisma/client';
import { verifyMatchMembership } from './buddyServiceClient.js';
import { creditCoinsService } from './coinLedgerService.js';
import { loadEconomyConfig } from './coinEconomyConfigService.js';
import { track } from '../utils/analytics.js';
import { startOfIsoWeek } from '../utils/isoWeek.js';
const prisma = new PrismaClient();

// startOfIsoWeek is shared with streakService (utils/isoWeek.js) so both
// normalize the close-week target to the same IST Monday — if they ever
// disagreed, advancePairedStreaksService would query a weekStart that
// streakService never wrote and silently see every pair as unqualified.

// Either member can opt the pair in — this build auto-enrolls both rather
// than building a separate invite/accept sub-flow, a deliberate scope cut
// for the pilot (see the schema's Phase 4 comment). Idempotent: opting in
// again just returns the existing row.
export async function optInService(userId, matchId) {
  const { matched, otherUserId } = await verifyMatchMembership(matchId, userId);
  if (!matched) throw { status: 403, error: 'You are not an active match member of this pair' };

  const existing = await prisma.pairedStreak.findUnique({ where: { matchId: Number(matchId) } });
  if (existing) {
    track('paired_streak_opted_in', userId, { match_id: Number(matchId), already: true });
    return existing;
  }

  const userAId = Math.min(userId, otherUserId);
  const userBId = Math.max(userId, otherUserId);
  try {
    const created = await prisma.pairedStreak.create({ data: { matchId: Number(matchId), userAId, userBId } });
    track('paired_streak_opted_in', userId, { match_id: Number(matchId), already: false });
    return created;
  } catch (err) {
    if (err.code === 'P2002') {
      return prisma.pairedStreak.findUnique({ where: { matchId: Number(matchId) } });
    }
    throw err;
  }
}

export async function getMyPairedStreaksService(userId) {
  const pairs = await prisma.pairedStreak.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
  });
  track('paired_streak_viewed', userId, {
    pair_count: pairs.length,
    active_count: pairs.filter((p) => p.currentStreak > 0).length,
    longest_streak: pairs.reduce((max, p) => Math.max(max, p.longestStreak ?? 0), 0),
  });
  return pairs;
}

async function userQualifiedForWeek(userId, weekStart) {
  const week = await prisma.userStreakWeek.findUnique({
    where: { userId_weekStart: { userId, weekStart } },
  });
  return !!week?.qualified;
}

// Called from closeWeekInternal right after streakService.closeWeek finishes
// finalizing individual UserStreakWeek rows for the same weekStart — a pair
// survives only if BOTH members independently qualified; otherwise it resets
// to 0, same "hard reset, no grace week" rule the individual streak uses.
export async function advancePairedStreaksService(weekStartDate) {
  const weekStart = startOfIsoWeek(weekStartDate);
  const pairs = await prisma.pairedStreak.findMany();
  if (pairs.length === 0) return [];

  const { pairedStreakWeeklyBonus } = await loadEconomyConfig();
  const results = [];
  for (const pair of pairs) {
    const [aQualified, bQualified] = await Promise.all([
      userQualifiedForWeek(pair.userAId, weekStart),
      userQualifiedForWeek(pair.userBId, weekStart),
    ]);
    const survived = aQualified && bQualified;
    const nextCurrent = survived ? pair.currentStreak + 1 : 0;
    const updated = await prisma.pairedStreak.update({
      where: { id: pair.id },
      data: {
        currentStreak: nextCurrent,
        longestStreak: Math.max(pair.longestStreak, nextCurrent),
        lastQualifiedWeekStart: survived ? weekStart : pair.lastQualifiedWeekStart,
      },
    });
    if (survived && pairedStreakWeeklyBonus > 0) {
      const weekKey = weekStart.toISOString();
      await Promise.all([
        creditCoinsService(pair.userAId, pairedStreakWeeklyBonus, 'Paired streak bonus', `paired-streak:${pair.id}:${weekKey}:a`),
        creditCoinsService(pair.userBId, pairedStreakWeeklyBonus, 'Paired streak bonus', `paired-streak:${pair.id}:${weekKey}:b`),
      ]);
    }
    results.push({ matchId: pair.matchId, survived, currentStreak: updated.currentStreak });
  }
  if (results.length > 0) {
    track('paired_streak_week_closed', null, {
      week_start: weekStart.toISOString(),
      pairs: results.length,
      survived: results.filter((r) => r.survived).length,
      broken: results.filter((r) => !r.survived).length,
    });
  }
  return results;
}
