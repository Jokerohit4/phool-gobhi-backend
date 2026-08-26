import { PrismaClient } from '@prisma/client';
import { creditCoinsService } from './coinLedgerService.js';
import { loadEconomyConfig } from './coinEconomyConfigService.js';
const prisma = new PrismaClient();

function startOfIsoWeek(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Idempotent on bookingId — booking-service's fire-and-forget call to
// POST /internal/attendance-events can retry freely without double-counting
// a check-in into the week's tally.
export async function recordAttendanceEvent({ userId, bookingId, gymId, attendedAt, source }) {
  const existing = await prisma.attendanceEventLog.findUnique({ where: { bookingId } });
  if (existing) return { alreadyRecorded: true };

  await prisma.attendanceEventLog.create({
    data: { userId, bookingId, gymId, attendedAt: new Date(attendedAt), source },
  });
  const weekStart = startOfIsoWeek(attendedAt);
  await prisma.userStreakWeek.upsert({
    where: { userId_weekStart: { userId, weekStart } },
    update: { checkinCount: { increment: 1 } },
    create: { userId, weekStart, checkinCount: 1 },
  });

  // Per-check-in coins, idempotent on the same bookingId as the
  // AttendanceEventLog row above — a retried call can never double-pay one
  // real check-in.
  const { coinsPerCheckin } = await loadEconomyConfig();
  if (coinsPerCheckin > 0) {
    await creditCoinsService(userId, coinsPerCheckin, 'Check-in reward', `checkin-coins:${bookingId}`);
  }

  return { alreadyRecorded: false };
}

// Cron entry point (POST /internal/streak/close-week). Finalizes every
// still-open UserStreakWeek row for the given week, updates each user's
// running streak, and issues the weekly-target bonus + any streak-milestone
// bonus that just fired. Both coin credits are idempotent on
// (userId, weekStart), so re-running close-week for an already-closed week
// (e.g. a manual retry) never double-pays.
export async function closeWeek(weekStartDate) {
  const weekStart = startOfIsoWeek(weekStartDate);
  const weekStartKey = weekStart.toISOString();
  const weeks = await prisma.userStreakWeek.findMany({ where: { weekStart, closedAt: null } });
  const { weeklyTargetBonus, milestones, qualifyingCheckinsPerWeek } = await loadEconomyConfig();
  const results = [];
  for (const week of weeks) {
    const qualified = week.checkinCount >= qualifyingCheckinsPerWeek;
    await prisma.userStreakWeek.update({
      where: { id: week.id },
      data: { qualified, closedAt: new Date() },
    });
    const streak = await prisma.userStreak.upsert({
      where: { userId: week.userId },
      update: {},
      create: { userId: week.userId, currentStreak: 0, longestStreak: 0 },
    });
    const nextCurrent = qualified ? streak.currentStreak + 1 : 0;
    const updated = await prisma.userStreak.update({
      where: { userId: week.userId },
      data: {
        currentStreak: nextCurrent,
        longestStreak: Math.max(streak.longestStreak, nextCurrent),
        lastQualifiedWeekStart: qualified ? weekStart : streak.lastQualifiedWeekStart,
      },
    });

    if (qualified) {
      if (weeklyTargetBonus > 0) {
        await creditCoinsService(
          week.userId, weeklyTargetBonus, 'Weekly streak target bonus',
          `weekly-bonus:${week.userId}:${weekStartKey}`,
        );
      }
      const milestoneAmount = milestones?.[String(nextCurrent)];
      if (milestoneAmount > 0) {
        await creditCoinsService(
          week.userId, milestoneAmount, `${nextCurrent}-week streak milestone`,
          `streak-milestone:${week.userId}:${weekStartKey}`,
        );
      }
    }

    results.push({ userId: week.userId, qualified, currentStreak: updated.currentStreak });
  }
  return results;
}

export async function getStreakService(userId) {
  const streak = await prisma.userStreak.findUnique({ where: { userId } });
  return streak || { userId, currentStreak: 0, longestStreak: 0, lastQualifiedWeekStart: null };
}
