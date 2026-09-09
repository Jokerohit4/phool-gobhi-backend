import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// DPDPA erasure for the gamification layer, called by auth-service when a
// user deletes their account.
//
// Everything here is behavioural data about one person — where they checked
// in and when, what they earned, how long their streak ran — so it goes.
// The one deliberate exception is CoinRedemption rows that were fulfilled
// against real money (a subscription discount routed through
// wallet-service): those are part of a financial record with statutory
// retention, and they carry no PII of their own once the auth User row is
// gone. Deleting them would corrupt reconciliation for a settlement that
// actually happened.
export async function eraseUserService(userId) {
  const enrollments = await prisma.challengeEnrollment.findMany({
    where: { userId },
    select: { id: true },
  });
  const enrollmentIds = enrollments.map((e) => e.id);

  const [redemptionsKept] = await Promise.all([
    prisma.coinRedemption.count({ where: { userId } }),
  ]);

  await prisma.$transaction([
    // Checkpoint visits hang off enrollments, which are about to go — and
    // each carries a lat/lng, i.e. a record of where this person physically
    // was. Removed first so no visit is orphaned by its enrollment.
    ...(enrollmentIds.length > 0
      ? [prisma.challengeCheckpointVisit.deleteMany({
          where: { enrollmentId: { in: enrollmentIds } },
        })]
      : []),
    prisma.challengeTeamMember.deleteMany({ where: { userId } }),
    prisma.challengeWinner.deleteMany({ where: { userId } }),
    prisma.challengeEnrollment.deleteMany({ where: { userId } }),
    // The attendance log is the most sensitive thing in this service: a
    // timestamped history of which gyms this person walked into.
    prisma.attendanceEventLog.deleteMany({ where: { userId } }),
    prisma.userStreakWeek.deleteMany({ where: { userId } }),
    prisma.userStreak.deleteMany({ where: { userId } }),
    prisma.coinLedgerEntry.deleteMany({ where: { userId } }),
    prisma.coinBalance.deleteMany({ where: { userId } }),
    // A paired streak belongs to two people. The pair cannot continue with
    // one member erased, so the row goes — the surviving member's own
    // streak/coins are untouched.
    prisma.pairedStreak.deleteMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
    }),
  ]);

  return {
    erased: true,
    enrollmentsRemoved: enrollmentIds.length,
    // Reported so the caller can log precisely what was retained and why,
    // rather than the retention being invisible.
    redemptionsRetainedForFinancialRecord: redemptionsKept,
  };
}
