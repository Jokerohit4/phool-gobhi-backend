import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// The server returns numbers, the client renders the card (BRD Tech §5.4:
// "image-spec payload"). Deliberately no name, no gym, no photo, nothing
// identifying — the card is meant to be shareable, and the BRD's rule is
// "share anonymised stats, no PII on card". Keeping that guarantee here
// rather than trusting each client to omit it means a future web/partner
// renderer can't accidentally reintroduce PII.

function isoWeekStart(dateStr) {
  const d = dateStr ? new Date(`${dateStr}T00:00:00Z`) : new Date();
  const day = d.getUTCDay();
  // Monday-start, matching challenge-service's UserStreakWeek convention so
  // "this week" means the same thing in the recap as in the streak.
  const diff = (day === 0 ? -6 : 1) - day;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() + diff);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function toLocalDate(d) {
  return d.toISOString().slice(0, 10);
}

export async function getWeeklyRecapService(userId, weekParam) {
  const start = isoWeekStart(weekParam);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);

  const sessions = await prisma.workoutSession.findMany({
    where: { userId, endedAt: { not: null }, startedAt: { gte: start, lt: end } },
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

    const dayIndex = Math.floor((s.startedAt.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
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
    weekStart: toLocalDate(start),
    weekEnd: toLocalDate(new Date(end.getTime() - 24 * 60 * 60 * 1000)),
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
