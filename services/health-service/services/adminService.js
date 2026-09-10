import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Aggregate counts only — no per-user drill-down, enforcing the
// customer-only visibility decision in the implementation plan. Gobhi staff
// get adoption numbers, never an individual's workout data.
export async function getAdoptionSummaryService() {
  const [consentedUsers, revokedUsers, totalSessions, finishedSessions, totalTemplates, syncedRecords, manualRecords] = await Promise.all([
    prisma.healthConsent.count({ where: { revokedAt: null } }),
    prisma.healthConsent.count({ where: { revokedAt: { not: null } } }),
    prisma.workoutSession.count(),
    prisma.workoutSession.count({ where: { endedAt: { not: null } } }),
    prisma.workoutTemplate.count(),
    prisma.exerciseRecord.count({ where: { source: { not: 'manual' } } }),
    prisma.exerciseRecord.count({ where: { source: 'manual' } }),
  ]);
  return {
    consentedUsers,
    revokedUsers,
    totalSessions,
    finishedSessions,
    totalTemplates,
    syncedExerciseRecords: syncedRecords,
    manualExerciseRecords: manualRecords,
  };
}
