import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Same tz convention as workoutSessionService's localDateIST — measurements
// are day-keyed for charting alongside sessions, so both must agree on what
// "today" means or a weight logged at 1am lands on the wrong day's point.
function localDateIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// FR-12. Upsert rather than create: re-entering today's weight corrects
// today's row instead of stacking a second one (the PRD's 2-tap "value +
// auto-today" entry implies one row per day). Passing only one of
// weight/bodyFat leaves the other untouched, so the two can be logged in
// separate taps without one wiping the other.
export async function upsertMeasurementService(userId, { localDate, weightKg, bodyFatPct }) {
  const day = localDate || localDateIST(new Date());
  const data = {
    ...(weightKg !== undefined ? { weightKg } : {}),
    ...(bodyFatPct !== undefined ? { bodyFatPct } : {}),
  };
  return prisma.measurement.upsert({
    where: { userId_localDate: { userId, localDate: day } },
    create: { userId, localDate: day, ...data },
    update: data,
  });
}

// Oldest-first: every consumer of this is a time series (the G10 measurement
// chart, the history list), and a chart wants its points in chronological
// order rather than reversing them client-side.
export async function listMeasurementsService(userId, { from, to } = {}) {
  return prisma.measurement.findMany({
    where: {
      userId,
      ...(from || to
        ? { localDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    orderBy: { localDate: 'asc' },
  });
}

export async function deleteMeasurementService(userId, localDate) {
  const existing = await prisma.measurement.findUnique({
    where: { userId_localDate: { userId, localDate } },
  });
  if (!existing || existing.userId !== userId) {
    const err = new Error('Measurement not found');
    err.status = 404;
    throw err;
  }
  await prisma.measurement.delete({ where: { id: existing.id } });
}
