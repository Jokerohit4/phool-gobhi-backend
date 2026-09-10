import { PrismaClient } from '@prisma/client';
import { verifyMatchMembership } from './buddyServiceClient.js';
import { creditCoinsService } from './coinLedgerService.js';
import { loadEconomyConfig } from './coinEconomyConfigService.js';
const prisma = new PrismaClient();

// Same normalization as streakService's startOfIsoWeek — duplicated rather
// than imported since this needs to match whatever weekStart streakService
// actually stored on UserStreakWeek for the same close-week run, and the
// controller passes through the same raw pre-normalization date to both.
function startOfIsoWeek(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Either member can opt the pair in — this build auto-enrolls both rather
// than building a separate invite/accept sub-flow, a deliberate scope cut
// for the pilot (see the schema's Phase 4 comment). Idempotent: opting in
// again just returns the existing row.
export async function optInService(userId, matchId) {
  const { matched, otherUserId } = await verifyMatchMembership(matchId, userId);
  if (!matched) throw { status: 403, error: 'You are not an active match member of this pair' };

  const existing = await prisma.pairedStreak.findUnique({ where: { matchId: Number(matchId) } });
  if (existing) return existing;

  const userAId = Math.min(userId, otherUserId);
  const userBId = Math.max(userId, otherUserId);
  try {
    return await prisma.pairedStreak.create({ data: { matchId: Number(matchId), userAId, userBId } });
  } catch (err) {
    if (err.code === 'P2002') {
      return prisma.pairedStreak.findUnique({ where: { matchId: Number(matchId) } });
    }
    throw err;
  }
}

export async function getMyPairedStreaksService(userId) {
  return prisma.pairedStreak.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
  });
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
  return results;
}
