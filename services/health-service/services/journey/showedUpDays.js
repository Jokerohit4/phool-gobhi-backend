import { PrismaClient } from '@prisma/client';
import { fetchInternal } from '../../utils/fetchInternal.js';

const prisma = new PrismaClient();
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayOf(instant) {
  return new Date(new Date(instant).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Get qualifying workout days from health-service's WorkoutSession table.
 * A qualifying workout day = a WorkoutSession where:
 * - type is not null and not 'rest'
 * - endedAt is set
 * - AND (has at least one WorkoutSet.completed = true via SessionExercise,
 *   OR has no sets and duration (endedAt - startedAt) >= 10 minutes)
 * The day comes from localDate, or from startedAt converted to IST when localDate is null.
 */
async function getQualifyingWorkoutDays(userId, from = null) {
  const where = {
    userId,
    type: { not: null, notIn: ['rest'] },
    endedAt: { not: null },
    ...(from ? { localDate: { gte: from } } : {}),
  };

  const sessions = await prisma.workoutSession.findMany({
    where,
    select: {
      localDate: true,
      startedAt: true,
      endedAt: true,
      exercises: {
        select: {
          sets: {
            where: { completed: true },
            select: { id: true },
          },
        },
      },
    },
  });

  const days = new Set();
  for (const session of sessions) {
    const hasCompletedSet = session.exercises.some((ex) => ex.sets.length > 0);
    const durationMinutes = hasCompletedSet
      ? null
      : (session.endedAt && session.startedAt
          ? (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000
          : 0);

    if (hasCompletedSet || durationMinutes >= 10) {
      const day = session.localDate ?? istDayOf(session.startedAt);
      days.add(day);
    }
  }

  return Array.from(days).sort();
}

/**
 * Get showed-up days by combining booking-service checkin-days with qualifying workout days.
 * Returns distinct IST days (YYYY-MM-DD), newest first, capped at 90 days.
 */
export async function getShowedUpDays(userId, from = null) {
  const [bookingDays, workoutDays] = await Promise.all([
    // booking-service internal endpoint returns {days: ["YYYY-MM-DD", ...]} distinct union
    // of Booking.attendedAt, MemberAttendance.date, IndependentCheckIn.date (IST)
    fetchInternal(BOOKING_SERVICE_URL, `/internal/users/${userId}/checkin-days${from ? `?from=${from}` : ''}`)
      .then((res) => (res.data?.days || []))
      .catch(() => []),
    getQualifyingWorkoutDays(userId, from),
  ]);

  const allDays = new Set([...bookingDays, ...workoutDays]);
  let daysArray = Array.from(allDays).sort().reverse(); // newest first

  if (daysArray.length > 90) {
    daysArray = daysArray.slice(0, 90);
  }

  return daysArray;
}

/**
 * Get the most recent showed-up day (for lastShowedUpDate in JourneyProgress).
 */
export async function getLastShowedUpDate(userId) {
  const days = await getShowedUpDays(userId);
  return days[0] ?? null;
}