import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Aggregate counts only — no per-user drill-down, enforcing the
// customer-only visibility decision in the implementation plan. Gobhi staff
// get adoption numbers, never an individual's workout data.
export async function getAdoptionSummaryService() {
  const [consentedUsers, revokedUsers, totalSessions, finishedSessions, totalTemplates, syncedRecords, manualRecords, runTrackerRecords] = await Promise.all([
    prisma.healthConsent.count({ where: { revokedAt: null } }),
    prisma.healthConsent.count({ where: { revokedAt: { not: null } } }),
    prisma.workoutSession.count(),
    prisma.workoutSession.count({ where: { endedAt: { not: null } } }),
    prisma.workoutTemplate.count(),
    // Excludes gps_tracker — "synced" here means a device-health summary
    // (HealthKit/Health Connect), not our own GPS run tracker, which is a
    // separate adoption signal (run-tracker-spec.html §10 flagged this: it
    // would otherwise be silently double-counted as "synced").
    prisma.exerciseRecord.count({ where: { source: { notIn: ['manual', 'gps_tracker'] } } }),
    prisma.exerciseRecord.count({ where: { source: 'manual' } }),
    prisma.exerciseRecord.count({ where: { source: 'gps_tracker' } }),
  ]);
  return {
    consentedUsers,
    revokedUsers,
    totalSessions,
    finishedSessions,
    totalTemplates,
    syncedExerciseRecords: syncedRecords,
    manualExerciseRecords: manualRecords,
    runTrackerRecords,
  };
}
