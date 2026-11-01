import { isoDayIST } from '../../utils/sessionDay.js';
import prisma from '../../db/prisma.js';
import { fetchInternal } from '../../utils/fetchInternal.js';
import { createTtlCache } from '../../utils/ttlCache.js';
import { onJourneyInvalidate } from '../../utils/journeyCacheBus.js';

const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';



function istDayOf(instant) {
  return isoDayIST(instant);
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
      type: true,
      startedAt: true,
      endedAt: true,
      exercises: {
        select: {
          sets: {
            select: { id: true, completed: true },
          },
        },
      },
    },
  });

  const days = new Set();
  for (const session of sessions) {
    if (isQualifyingSession(session)) {
      const day = session.localDate ?? istDayOf(session.startedAt);
      days.add(day);
    }
  }

  return Array.from(days).sort();
}

/**
 * Check if a session qualifies as a workout day.
 * A qualifying session = type not null, not 'rest', endedAt set,
 * AND (has at least one completed set OR no sets with duration >= 10 minutes).
 * Used by both rowProgress (local DB) and showedUpDays (for history).
 * @param {object} session - WorkoutSession with exercises/sets
 * @returns {boolean}
 */
export function isQualifyingSession(session) {
  if (!session.type || session.type === 'rest' || !session.endedAt) return false;
  // Callers must retain all sets and their completed flag. Filtering to
  // completed sets would make an unfinished workout look like a no-set log.
  const sets = session.exercises?.flatMap((ex) => ex.sets ?? []) ?? [];
  if (sets.some((set) => set.completed === true)) return true;
  if (sets.length > 0) return false;
  if (session.startedAt && session.endedAt) {
    const durationMinutes = (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000;
    return durationMinutes >= 10;
  }
  return false;
}

/**
 * Get showed-up days by combining booking-service checkin-days with qualifying workout days.
 * Returns distinct IST days (YYYY-MM-DD), newest first, capped at 90 days.
 */
// Every journey/plan read needs this, and it costs a cross-service HTTP call to
// booking-service (+ its DB query) on top of ours. The default call (whole
// history, 90-day cap) is cached per user for a few seconds; one app launch
// fans out into /plan/today, /journey and /journey/summary which all want it.
// Booking check-ins happen in another service and can't evict, so the TTL is
// the staleness bound; our own workout finishes evict explicitly.
const SHOWED_UP_TTL_MS = Number(process.env.SHOWED_UP_DAYS_CACHE_TTL_MS ?? 10_000);
const showedUpCache = createTtlCache({ ttlMs: SHOWED_UP_TTL_MS });

export function invalidateShowedUpDays(userId) {
  showedUpCache.invalidate(Number(userId));
}
// Evicted with the journey cache on the shared bus (workout finish, consent erase,
// journey writes) — journeyService doesn't need to import this module for it.
onJourneyInvalidate(invalidateShowedUpDays);

async function loadShowedUpDays(userId, from, { to, limit }) {
  let degraded = false;
  const [bookingDays, workoutDays] = await Promise.all([
    // booking-service internal endpoint returns {days: ["YYYY-MM-DD", ...]} distinct union
    // of Booking.attendedAt, MemberAttendance.date, IndependentCheckIn.date (IST)
    fetchInternal(BOOKING_SERVICE_URL, `/internal/users/${userId}/checkin-days${from ? `?from=${from}` : ''}`)
      .then((res) => (res.data?.days || []))
      .catch(() => { degraded = true; return []; }),
    getQualifyingWorkoutDays(userId, from),
  ]);

  const allDays = new Set([...bookingDays, ...workoutDays]);
  let daysArray = Array.from(allDays).filter(day => !to || day <= to).sort().reverse(); // newest first

  if (daysArray.length > limit) {
    daysArray = daysArray.slice(0, limit);
  }

  return { days: daysArray, degraded };
}

export async function getShowedUpDays(userId, from = null, { to = null, limit = 90 } = {}) {
  if (from || to || limit !== 90) {
    return (await loadShowedUpDays(userId, from, { to, limit })).days;
  }
  // A degraded result (booking-service unreachable → workout days only) is served
  // to this caller as before but never cached, so one blip can't hide check-in
  // days for the whole TTL.
  const result = await showedUpCache.get(
    Number(userId),
    () => loadShowedUpDays(userId, null, { to: null, limit }),
    { cacheable: (r) => !r.degraded },
  );
  return [...result.days]; // callers own their copy
}

/**
 * Get the most recent showed-up day (for lastShowedUpDate in JourneyProgress).
 */
export async function getLastShowedUpDate(userId) {
  const days = await getShowedUpDays(userId);
  return days[0] ?? null;
}
