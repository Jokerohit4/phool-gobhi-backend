import { PrismaClient } from '@prisma/client';
import { fetchAttendanceSince } from '../utils/fetchAttendance.js';

const prisma = new PrismaClient();

// The last piece of FR-03: "you were at the gym and haven't said what you
// did." Everything else about the attendance attachment shipped on
// 2026-09-08; this is the read that turns it into a prompt.
//
// A visit counts as unlogged when there is an attendance event for it and
// no FINISHED session on that local date. An in-progress session counts as
// logged: the user is mid-workout, and telling them to log something they
// are currently doing is the sort of nudge that gets notifications turned
// off.
const WINDOW_HOURS = 24;

function localDateIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export async function getUnloggedAttendanceService(userId) {
  const events = await fetchAttendanceSince(WINDOW_HOURS, { userId });
  if (events.length === 0) return [];

  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
  const sessions = await prisma.workoutSession.findMany({
    where: { userId, startedAt: { gte: since } },
    select: { localDate: true, startedAt: true, endedAt: true },
  });

  const loggedDays = new Set(
    sessions
      .filter((s) => s.endedAt !== null)
      .map((s) => s.localDate || localDateIST(s.startedAt)),
  );

  // One entry per day, not per check-in: two gyms in a day is one prompt.
  // Someone who trained twice does not need telling twice.
  const byDay = new Map();
  for (const event of events) {
    const day = localDateIST(event.attendedAt);
    if (loggedDays.has(day)) continue;
    if (!byDay.has(day)) {
      byDay.set(day, {
        localDate: day,
        gymId: event.gymId ?? null,
        bookingId: event.bookingId ?? null,
        attendedAt: event.attendedAt,
        source: event.source,
      });
    }
  }

  return [...byDay.values()].sort((a, b) => b.localDate.localeCompare(a.localDate));
}

/// Platform-wide version for the nudge sweep: every user with attendance in
/// the window and nothing finished for that day. One query per side rather
/// than per user - the sweep runs over everyone who trained today, and
/// N+1-ing that would scale with the gym network.
export async function findUnloggedUsersService({ minMinutesSince, maxHours }) {
  const events = await fetchAttendanceSince(maxHours);
  if (events.length === 0) return [];

  const cutoff = Date.now() - minMinutesSince * 60 * 1000;
  // Only visits that have had time to be logged. The nudge is "you forgot",
  // and 90 minutes after a check-in the user may still be on the gym floor.
  const ripe = events.filter((e) => new Date(e.attendedAt).getTime() <= cutoff);
  if (ripe.length === 0) return [];

  const userIds = [...new Set(ripe.map((e) => e.userId))];
  const since = new Date(Date.now() - maxHours * 60 * 60 * 1000);
  const sessions = await prisma.workoutSession.findMany({
    where: { userId: { in: userIds }, startedAt: { gte: since }, endedAt: { not: null } },
    select: { userId: true, localDate: true, startedAt: true },
  });

  const loggedByUser = new Map();
  for (const s of sessions) {
    const day = s.localDate || localDateIST(s.startedAt);
    if (!loggedByUser.has(s.userId)) loggedByUser.set(s.userId, new Set());
    loggedByUser.get(s.userId).add(day);
  }

  const out = [];
  const seen = new Set();
  for (const event of ripe) {
    const day = localDateIST(event.attendedAt);
    const key = `${event.userId}:${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (loggedByUser.get(event.userId)?.has(day)) continue;
    out.push({ userId: event.userId, localDate: day, gymId: event.gymId ?? null });
  }
  return out;
}
