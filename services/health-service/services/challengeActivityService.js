import { isoDayIST } from '../utils/sessionDay.js';
const METRICS = ['water_consistency', 'mood_consistency', 'workout_consistency'];

function dayOf(value) {
  return isoDayIST(value);
}

// Only counts and timestamps cross the service boundary, never moods or notes.
export async function challengeActivity(prisma, { userId, since, metric, verifiedAttendance = false, now = new Date() }) {
  userId = Number(userId);
  const start = new Date(since);
  if (!Number.isInteger(userId) || userId <= 0 || !METRICS.includes(metric) ||
      !Number.isFinite(start.getTime()) || start > now) {
    throw { status: 400, error: 'Invalid challenge activity request' };
  }
  const where = { userId, createdAt: { gte: start, lte: now } };
  let dates;
  if (metric === 'water_consistency') {
    const rows = await prisma.waterLog.findMany({ where: { ...where, ml: { gt: 0 } }, select: { createdAt: true } });
    dates = rows.map(row => row.createdAt);
  } else if (metric === 'mood_consistency') {
    const rows = await prisma.wellnessMoodCheckIn.findMany({ where, select: { createdAt: true } });
    dates = rows.map(row => row.createdAt);
  } else {
    const rows = await prisma.workoutSession.findMany({
      where: { userId, startedAt: { gte: start }, endedAt: { gte: start, lte: now },
        NOT: { type: 'rest' }, ...(verifiedAttendance ? { attendedAt: { not: null } } : {}) },
      select: { startedAt: true, endedAt: true, type: true,
        exercises: { select: { sets: { select: { completed: true } } } } },
    });
    dates = rows.filter(row => isQualifyingSession(row) && new Date(row.endedAt) - new Date(row.startedAt) >= 10 * 60000).map(row => row.endedAt);
  }
  return { count: new Set(dates.map(dayOf)).size };
}
import { isQualifyingSession } from './journey/showedUpDays.js';

