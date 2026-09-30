// Reads the allowed inputs for ig-v1 and hands them to the pure function.
//
// The query list below IS the input contract: nothing device-synced is read
// here at all (no DailyActivityMetric, no healthkit/health_connect
// ExerciseRecords), so the pure function's own filtering is a second wall, not
// the only one.
//
// Plan ticks and the pause window are ledger data, which sits behind the
// healthLedger flag and the user's `nutrition` consent scope (the scope the
// ledger as a whole is gated on - see routes/ledger.js). If either is off for
// this user they are not read, and the payload says so in `excluded` rather
// than showing zeros that would read as "planned nothing, did nothing".
import { computeInsurerGrade, canonicalize, localDateIST } from './insurerGrade.js';
import { createHash } from 'node:crypto';

export async function buildInsurerGradeService(prisma, { userId, from, to, now = new Date(), ledgerAllowed }) {
  const [sessions, exerciseRecords, weeklyGoal] = await Promise.all([
    prisma.workoutSession.findMany({
      where: { userId, bookingId: { not: null } },
      select: { bookingId: true, localDate: true, attendedAt: true, attendanceMethod: true },
    }),
    prisma.exerciseRecord.findMany({
      where: { userId, source: { in: ['manual', 'gps_tracker'] } },
      select: { source: true, startedAt: true, endedAt: true, createdAt: true },
    }),
    prisma.weeklyGoal.findUnique({ where: { userId }, select: { sessionsPerWeek: true } }),
  ]);

  let planItems = [];
  let completions = [];
  let pause = null;
  const extraExclusions = [];
  if (ledgerAllowed) {
    [planItems, completions, pause] = await Promise.all([
      prisma.planItem.findMany({
        where: { userId, kind: { in: ['workout', 'habit', 'rest'] } },
        select: { id: true, kind: true, schedule: true, active: true, endsOn: true, createdAt: true },
      }),
      prisma.planItemCompletion.findMany({
        where: { userId, localDate: { gte: from, lte: to } },
        select: { planItemId: true, localDate: true, createdAt: true },
      }),
      prisma.healthGoal.findUnique({ where: { userId }, select: { pausedFrom: true, pausedUntil: true } }),
    ]);
  } else {
    extraExclusions.push({
      category: 'plan_ticks',
      reason: 'The health ledger is off for this account, so plan ticks and pauses are not included.',
    });
  }

  const payload = computeInsurerGrade({
    from, to, sessions, exerciseRecords, planItems, completions, weeklyGoal, pause, now,
  });
  if (extraExclusions.length) payload.excluded = [...payload.excluded, ...extraExclusions];

  // What would be signed, and its hash. `generatedAt` is outside the payload
  // on purpose: the same inputs must canonicalize identically whenever they
  // are computed, so the hash identifies the content rather than the request.
  const canonical = canonicalize(payload);
  return {
    payload,
    canonicalSha256: createHash('sha256').update(canonical).digest('hex'),
    generatedAt: new Date(now).toISOString(),
    serverToday: localDateIST(now),
  };
}
