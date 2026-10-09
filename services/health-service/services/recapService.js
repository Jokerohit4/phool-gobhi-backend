import { PrismaClient } from '@prisma/client';
import {
  istDateString, dayString, dayToDate, addDays, startOfIsoWeek, COUNTED_WORKOUT_WHERE,
} from '../utils/sessionDay.js';
const prisma = new PrismaClient();

// The server returns numbers, the client renders the card (BRD Tech §5.4:
// "image-spec payload"). Deliberately no name, no gym, no photo, nothing
// identifying — the card is meant to be shareable, and the BRD's rule is
// "share anonymised stats, no PII on card". Keeping that guarantee here
// rather than trusting each client to omit it means a future web/partner
// renderer can't accidentally reintroduce PII.

// The Monday-start week boundary is shared (utils/sessionDay, IST-anchored),
// matching challenge-service's UserStreakWeek convention so "this week" means
// the same thing in the recap as in the streak.
export async function getWeeklyRecapService(userId, weekParam) {
  const start = startOfIsoWeek(weekParam ? dayToDate(weekParam) : new Date());
  const startStr = dayString(start);
  const end = addDays(start, 7);
  const endStr = dayString(end);

  // A counted workout only (finished, non-rest, >=1 completed set), so a rest
  // log or an empty quick-log doesn't appear as a session on the recap card.
  // Bounded on localDate — the day the user experienced — with a startedAt
  // fallback for rows that predate that column.
  const sessions = await prisma.workoutSession.findMany({
    where: {
      userId,
      ...COUNTED_WORKOUT_WHERE,
      OR: [
        { localDate: { gte: startStr, lt: endStr } },
        { AND: [{ localDate: null }, { startedAt: { gte: start, lt: end } }] },
      ],
    },
    include: {
      exercises: {
        include: { exercise: { select: { name: true } }, sets: { where: { completed: true } } },
      },
    },
    orderBy: { startedAt: 'asc' },
  });

  let volumeKg = 0;
  let minutes = 0;
  let rpeSum = 0;
  let rpeCount = 0;
  let bestLift = null;
  // One flag per weekday (Mon..Sun) — the little activity strip on the card.
  const activeDays = [false, false, false, false, false, false, false];

  for (const s of sessions) {
    if (s.endedAt) minutes += Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60000);
    if (s.rpe) { rpeSum += s.rpe; rpeCount += 1; }

    const day = s.localDate || istDateString(s.startedAt);
    const dayIndex = Math.round((dayToDate(day).getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    if (dayIndex >= 0 && dayIndex < 7) activeDays[dayIndex] = true;

    for (const se of s.exercises) {
      for (const set of se.sets) {
        if (!set.weightKg || !set.reps) continue;
        const weight = Number(set.weightKg);
        volumeKg += weight * set.reps;
        if (!bestLift || weight > bestLift.weightKg) {
          bestLift = { exerciseName: se.exercise.name, weightKg: weight, reps: set.reps };
        }
      }
    }
  }

  return {
    weekStart: startStr,
    weekEnd: dayString(addDays(start, 6)),
    sessions: sessions.length,
    minutes,
    volumeKg: Math.round(volumeKg),
    avgRpe: rpeCount > 0 ? Math.round((rpeSum / rpeCount) * 10) / 10 : null,
    bestLift,
    activeDays,
    // Nothing to celebrate yet is a legitimate state, and the client needs
    // to know to show the empty variant rather than a card of zeroes (PRD
    // §6 UX-6: never a blank canvas).
    isEmpty: sessions.length === 0,
  };
}
