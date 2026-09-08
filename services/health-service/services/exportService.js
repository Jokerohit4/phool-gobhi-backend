import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// FR-16. One builder feeds both the JSON and CSV shapes — the BRD's "Robin
// Hood rule" (Tech §8.3) is that an export and the on-screen numbers for the
// same range must never disagree, which only holds if there's a single
// implementation of "what happened in this range".
export async function buildRangeSeriesService(userId, { from, to } = {}) {
  const dateFilter = from || to
    ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
    : undefined;

  const [sessions, biometrics] = await Promise.all([
    prisma.workoutSession.findMany({
      where: {
        userId,
        endedAt: { not: null },
        ...(dateFilter ? { localDate: dateFilter } : {}),
      },
      include: {
        exercises: {
          include: { exercise: { select: { name: true, muscleGroup: true } }, sets: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.biometricEntry.findMany({
      where: { userId, ...(dateFilter ? { localDate: dateFilter } : {}) },
      orderBy: [{ localDate: 'asc' }, { metric: 'asc' }],
    }),
  ]);

  return {
    sessions: sessions.map((s) => {
      let volumeKg = 0;
      let completedSets = 0;
      for (const se of s.exercises) {
        for (const set of se.sets) {
          if (!set.completed) continue;
          completedSets += 1;
          if (set.weightKg && set.reps) volumeKg += Number(set.weightKg) * set.reps;
        }
      }
      return {
        sessionId: s.id,
        localDate: s.localDate,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMinutes: s.endedAt
          ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60000)
          : null,
        type: s.type,
        rpe: s.rpe,
        gymId: s.gymId,
        bookingId: s.bookingId,
        exerciseCount: s.exercises.length,
        completedSets,
        volumeKg: Math.round(volumeKg),
      };
    }),
    // Long-format (one row per metric per day) rather than a wide
    // weight/bodyFat pair — it stays correct as Health+ Phase 1 adds sleep,
    // resting HR, HRV and steps without the CSV growing a column per metric
    // and old exports changing shape.
    biometrics: biometrics.map((b) => ({
      localDate: b.localDate,
      metric: b.metric,
      value: Number(b.value),
      unit: b.unit,
      source: b.source,
    })),
  };
}

// Minimal, dependency-free CSV writer. Quotes only when a value actually
// needs it and doubles embedded quotes, so an exercise name with a comma
// can't shift every following column.
function toCsv(rows, columns) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escape(row[col])).join(','));
  }
  return lines.join('\n');
}

const SESSION_COLUMNS = [
  'sessionId', 'localDate', 'startedAt', 'endedAt', 'durationMinutes',
  'type', 'rpe', 'gymId', 'bookingId', 'exerciseCount', 'completedSets', 'volumeKg',
];
const BIOMETRIC_COLUMNS = ['localDate', 'metric', 'value', 'unit', 'source'];

// Two logical tables in one file, separated by a blank line and a header —
// a single flat CSV would either duplicate session rows per biometric or
// drop one of the two entirely. Sheets/Excel both handle this fine.
export function seriesToCsv({ sessions, biometrics }) {
  return [
    '# sessions',
    toCsv(sessions, SESSION_COLUMNS),
    '',
    '# biometrics',
    toCsv(biometrics, BIOMETRIC_COLUMNS),
    '',
  ].join('\n');
}
