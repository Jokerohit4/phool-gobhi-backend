import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// DPDPA access right (s.11) for the gamification layer, called by
// auth-service's platform-wide export. The mirror of erasureService.
//
// Note the asymmetry with erasure, which is deliberate rather than an
// oversight: fulfilled CoinRedemption rows are NOT deleted on erasure
// (statutory financial retention) and they ARE included here. Data we keep is
// data the person is entitled to see - that is the whole point of an access
// right existing alongside an erasure right.
export async function buildExportService(userId) {
  const [balance, ledger, attendance, streak, streakWeeks, enrollments, teamMemberships, wins, redemptions, sprouts] =
    await Promise.all([
      prisma.coinBalance.findUnique({ where: { userId } }),
      prisma.coinLedgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.attendanceEventLog.findMany({ where: { userId }, orderBy: { attendedAt: 'asc' } }),
      prisma.userStreak.findUnique({ where: { userId } }),
      prisma.userStreakWeek.findMany({ where: { userId }, orderBy: { weekStart: 'asc' } }),
      prisma.challengeEnrollment.findMany({
        where: { userId },
        include: {
          challenge: { select: { id: true, city: true, challengeDefinition: { select: { title: true } } } },
          checkpointVisits: true,
          rewardIssuance: true,
        },
        orderBy: { startedAt: 'asc' },
      }),
      prisma.challengeTeamMember.findMany({ where: { userId }, include: { team: { select: { name: true } } } }),
      prisma.challengeWinner.findMany({ where: { userId }, orderBy: { resolvedAt: 'asc' } }),
      prisma.coinRedemption.findMany({
        where: { userId },
        include: { catalogItem: { select: { title: true, category: true } } },
        orderBy: { id: 'asc' },
      }),
      prisma.sproutSpawn.findMany({ where: { caughtByUserId: userId }, orderBy: { caughtAt: 'asc' } }),
    ]);

  return {
    coins: {
      balance: balance?.balance ?? 0,
      ledger: ledger.map((e) => ({
        at: e.createdAt, type: e.type, amount: e.amount, description: e.description,
      })),
    },
    // The most sensitive thing this service holds: a timestamped history of
    // which gyms this person physically walked into.
    attendance: attendance.map((a) => ({
      at: a.attendedAt, gymId: a.gymId, source: a.source, bookingId: a.bookingId,
    })),
    streak: streak
      ? {
          currentStreak: streak.currentStreak,
          longestStreak: streak.longestStreak,
          lastQualifiedWeekStart: streak.lastQualifiedWeekStart,
        }
      : null,
    weeks: streakWeeks.map((w) => ({
      weekStart: w.weekStart, checkinCount: w.checkinCount, qualified: w.qualified, closedAt: w.closedAt,
    })),
    challenges: enrollments.map((e) => ({
      challengeId: e.challenge.id,
      title: e.challenge.challengeDefinition?.title ?? null,
      city: e.challenge.city,
      status: e.status,
      progressCount: e.progressCount,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      // Each visit carries a lat/lng - a record of where this person stood.
      checkpointVisits: e.checkpointVisits.map((v) => ({ at: v.verifiedAt, lat: v.lat, lng: v.lng })),
      reward: e.rewardIssuance
        ? { at: e.rewardIssuance.issuedAt, type: e.rewardIssuance.rewardType, coinAmount: e.rewardIssuance.coinAmount }
        : null,
    })),
    teams: teamMemberships.map((t) => ({ teamName: t.team?.name ?? null, role: t.role })),
    wins: wins.map((w) => ({ challengeId: w.challengeId, rank: w.rank, at: w.resolvedAt })),
    redemptions: redemptions.map((r) => ({
      at: r.id, item: r.catalogItem?.title ?? null, category: r.catalogItem?.category ?? null,
      coinCost: r.coinCost, status: r.status,
    })),
    sproutsCaught: sprouts.map((s) => ({ at: s.caughtAt, species: s.speciesKey, lat: s.lat, lng: s.lng })),
  };
}
