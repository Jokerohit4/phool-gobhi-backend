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

// The full DPDPA access-right slice for this service, called by
// auth-service's platform-wide export. Distinct from buildRangeSeriesService
// above, which is FR-16's user-facing training export: that one is a
// date-ranged view built for reading and charting, this one is "everything
// health-service holds about you", with no range and nothing summarised away.
//
// The list below deliberately mirrors consentService.deleteAllDataService
// one-for-one. If a table is added to the erasure and not to this, we would
// be deleting on request something we never showed on request - so keep the
// two in step.
export async function buildFullExportService(userId) {
  const [consent, personalisation, weeklyGoal, activePlan, templates, customExercises, records, activity, biometrics, feedback] =
    await Promise.all([
      prisma.healthConsent.findUnique({ where: { userId } }),
      prisma.personalisationProfile.findUnique({ where: { userId } }),
      prisma.weeklyGoal.findUnique({ where: { userId } }),
      prisma.userActivePlan.findUnique({ where: { userId }, include: { plan: { select: { key: true, name: true } } } }),
      prisma.workoutTemplate.findMany({
        where: { userId },
        include: { exercises: { include: { exercise: { select: { name: true } } }, orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.exercise.findMany({ where: { createdByUserId: userId }, orderBy: { createdAt: 'asc' } }),
      prisma.exerciseRecord.findMany({ where: { userId }, orderBy: { startedAt: 'asc' } }),
      prisma.dailyActivityMetric.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
      prisma.biometricEntry.findMany({ where: { userId }, orderBy: [{ localDate: 'asc' }, { metric: 'asc' }] }),
      prisma.suggestionFeedback.findMany({ where: { userId }, orderBy: { shownAt: 'asc' } }),
    ]);

  // Reuses the range builder with no range, so the session shape in a
  // platform export and in the user's own FR-16 download can never drift
  // apart - the Robin Hood rule applied across two endpoints instead of two
  // formats.
  const { sessions } = await buildRangeSeriesService(userId);

  return {
    consent: consent
      ? { grantedAt: consent.grantedAt, revokedAt: consent.revokedAt, policyVersion: consent.policyVersion, platform: consent.platform }
      : null,
    personalisation: personalisation
      ? {
          heightCm: personalisation.heightCm,
          setupWeightKg: personalisation.setupWeightKg === null ? null : Number(personalisation.setupWeightKg),
          experienceLevel: personalisation.experienceLevel,
          injuryZones: personalisation.injuryZones,
          energyPattern: personalisation.energyPattern,
          preferredRestDay: personalisation.preferredRestDay,
          programmingMode: personalisation.programmingMode,
          // Records THAT consent was given and under which policy version.
          // There is deliberately nothing here about what was disclosed to
          // arrive at the mode, because that was never transmitted.
          consentAt: personalisation.consentAt,
          privacyVersion: personalisation.privacyVersion,
          trainingLocation: personalisation.trainingLocation,
        }
      : null,
    // The user's weekly training target, and whether they chose it or it was
    // derived from their onboarding answer. Exported for the same reason it
    // is erased: it's their preference, not our configuration.
    weeklyGoal: weeklyGoal
      ? { sessionsPerWeek: weeklyGoal.sessionsPerWeek, setByUser: weeklyGoal.setByUser, updatedAt: weeklyGoal.updatedAt }
      : null,
    // Which multi-week plan the user has active, and since when — not the
    // day-by-day derived position (that's a live computation, not a stored
    // fact about them; getActivePlanService is the source for "what day is
    // it", this is only the source for "which plan, since when").
    activePlan: activePlan
      ? { planKey: activePlan.plan.key, planName: activePlan.plan.name, startedOn: activePlan.startedOn, completedAt: activePlan.completedAt }
      : null,
    sessions,
    routines: templates.map((t) => ({
      name: t.name,
      createdAt: t.createdAt,
      exercises: t.exercises.map((te) => ({
        name: te.exercise?.name ?? null, targetSets: te.targetSets, targetReps: te.targetReps, targetDurationSeconds: te.targetDurationSeconds, restSeconds: te.restSeconds,
      })),
    })),
    customExercises: customExercises.map((e) => ({
      name: e.name, muscleGroup: e.muscleGroup, equipment: e.equipment, loggingType: e.loggingType, createdAt: e.createdAt,
    })),
    cardioAndOther: records.map((r) => ({
      type: r.type, source: r.source, startedAt: r.startedAt, endedAt: r.endedAt,
      durationSeconds: r.durationSeconds, caloriesBurned: r.caloriesBurned,
      distanceMeters: r.distanceMeters === null ? null : Number(r.distanceMeters),
      avgHeartRateBpm: r.avgHeartRateBpm,
    })),
    dailyActivity: activity.map((a) => ({
      date: a.date, steps: a.steps, activeCalories: a.activeCalories,
      distanceMeters: a.distanceMeters === null ? null : Number(a.distanceMeters),
      restingHeartRateBpm: a.restingHeartRateBpm, source: a.source, syncedAt: a.syncedAt,
    })),
    biometrics: biometrics.map((b) => ({
      localDate: b.localDate, metric: b.metric, value: Number(b.value), unit: b.unit, source: b.source,
    })),
    // Included because it is per-user behavioural data we hold, even though
    // it exists only to be aggregated away - see retentionService bucket 1.
    // It is the one slice here that expires on a clock rather than with the
    // account, so the export says so rather than leaving that surprising.
    suggestionFeedback: feedback.map((f) => ({ shownAt: f.shownAt, suggestionKey: f.suggestionKey })),
    retentionNote:
      'suggestionFeedback is purpose-limited telemetry and is deleted automatically once it ages past the configured retention window; everything else here is kept for as long as your account exists',
  };
}
