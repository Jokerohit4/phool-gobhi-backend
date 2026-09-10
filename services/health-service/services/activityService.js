import { PrismaClient } from '@prisma/client';
import { EXERCISE_RECORD_SOURCES, EXERCISE_RECORD_TYPES, DAILY_ACTIVITY_SOURCES } from '../constants/healthEnums.js';
const prisma = new PrismaClient();

// Cardio/yoga/other duration-based entries — manual create, and the same
// endpoint doubles as the batch-upsert target for device-synced workout
// summaries (source: healthkit/health_connect), deduped on
// [userId, source, externalId] per the schema's unique constraint.
export async function createExerciseRecordService(userId, body) {
  const { source = 'manual', externalId, type, startedAt, endedAt, durationSeconds, caloriesBurned, distanceMeters, avgHeartRateBpm } = body || {};
  if (!EXERCISE_RECORD_SOURCES.includes(source)) {
    const err = new Error('Invalid source');
    err.status = 400;
    throw err;
  }
  if (!EXERCISE_RECORD_TYPES.includes(type)) {
    const err = new Error('type must be one of ' + EXERCISE_RECORD_TYPES.join(', '));
    err.status = 400;
    throw err;
  }
  if (!startedAt || !endedAt || !durationSeconds) {
    const err = new Error('startedAt, endedAt and durationSeconds are required');
    err.status = 400;
    throw err;
  }
  if (source !== 'manual' && !externalId) {
    const err = new Error('externalId is required for a synced record');
    err.status = 400;
    throw err;
  }
  const data = {
    userId,
    source,
    externalId: externalId ?? null,
    type,
    startedAt: new Date(startedAt),
    endedAt: new Date(endedAt),
    durationSeconds,
    caloriesBurned: caloriesBurned ?? null,
    distanceMeters: distanceMeters ?? null,
    avgHeartRateBpm: avgHeartRateBpm ?? null,
  };
  // Manual entries have no externalId, so the unique constraint doesn't
  // apply the same way — every manual save is just a plain create. Synced
  // rows upsert on the (userId, source, externalId) triple so re-syncing
  // the same HealthKit/Health Connect workout is a no-op, not a duplicate.
  if (source === 'manual') {
    return prisma.exerciseRecord.create({ data });
  }
  return prisma.exerciseRecord.upsert({
    where: { userId_source_externalId: { userId, source, externalId } },
    update: data,
    create: data,
  });
}

export async function listExerciseRecordsService(userId, { limit = 50 } = {}) {
  return prisma.exerciseRecord.findMany({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    take: Number(limit),
  });
}

// Batch upsert by date — the device-health sync path sends one row per day
// since the last sync anchor. Whole-row replace per day, never a partial
// patch (see the schema comment on DailyActivityMetric).
export async function syncDailyActivityService(userId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const err = new Error('rows must be a non-empty array');
    err.status = 400;
    throw err;
  }
  for (const row of rows) {
    if (!row.date || !DAILY_ACTIVITY_SOURCES.includes(row.source)) {
      const err = new Error('Each row needs date and a valid source');
      err.status = 400;
      throw err;
    }
  }
  return prisma.$transaction(
    rows.map((row) =>
      prisma.dailyActivityMetric.upsert({
        where: { userId_date: { userId, date: row.date } },
        update: {
          steps: row.steps ?? null,
          activeCalories: row.activeCalories ?? null,
          distanceMeters: row.distanceMeters ?? null,
          restingHeartRateBpm: row.restingHeartRateBpm ?? null,
          source: row.source,
          syncedAt: new Date(),
        },
        create: {
          userId,
          date: row.date,
          steps: row.steps ?? null,
          activeCalories: row.activeCalories ?? null,
          distanceMeters: row.distanceMeters ?? null,
          restingHeartRateBpm: row.restingHeartRateBpm ?? null,
          source: row.source,
        },
      }),
    ),
  );
}

export async function getDailyActivityService(userId, { from, to } = {}) {
  return prisma.dailyActivityMetric.findMany({
    where: {
      userId,
      ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { date: 'desc' },
  });
}
