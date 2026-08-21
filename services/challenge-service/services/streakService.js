import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// A week qualifies once a user logs this many verified attendance events
// inside it. Strawman value from the 2026-08-15 planning doc; revisit once
// real check-in frequency data exists.
export const QUALIFYING_CHECKINS_PER_WEEK = 2;

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
  return { alreadyRecorded: false };
}

// Cron entry point (POST /internal/streak/close-week). Finalizes every
// still-open UserStreakWeek row for the given week, updates each user's
// running streak, and returns the list of users who just qualified (Phase 2
// wires milestone coin issuance onto this return value — deliberately not
// wired yet in Phase 0, per the plan's phased scope).
export async function closeWeek(weekStartDate) {
  const weekStart = startOfIsoWeek(weekStartDate);
  const weeks = await prisma.userStreakWeek.findMany({ where: { weekStart, closedAt: null } });
  const results = [];
  for (const week of weeks) {
    const qualified = week.checkinCount >= QUALIFYING_CHECKINS_PER_WEEK;
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
    results.push({ userId: week.userId, qualified, currentStreak: updated.currentStreak });
  }
  return results;
}

export async function getStreakService(userId) {
  const streak = await prisma.userStreak.findUnique({ where: { userId } });
  return streak || { userId, currentStreak: 0, longestStreak: 0, lastQualifiedWeekStart: null };
}
