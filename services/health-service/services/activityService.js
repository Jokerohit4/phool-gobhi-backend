import prisma from '../db/prisma.js';
import { EXERCISE_RECORD_SOURCES, EXERCISE_RECORD_TYPES, DAILY_ACTIVITY_SOURCES } from '../constants/healthEnums.js';
import { METRIC_UNITS, validateLocalDate, validateMetricValue } from './biometricService.js';
import { invalidateBlendedScore } from './ledger/blendedScoreCache.js';
import { emitJourneyInvalidate } from '../utils/journeyCacheBus.js';

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

function validateSyncRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const err = new Error('rows must be a non-empty array');
    err.status = 400;
    throw err;
  }
  for (const row of rows) {
    if (!row || !row.date || !DAILY_ACTIVITY_SOURCES.includes(row.source)) {
      const err = new Error('Each row needs date and a valid source');
      err.status = 400;
      throw err;
    }
  }
}

const activityFields = ['steps', 'activeCalories', 'distanceMeters', 'restingHeartRateBpm'];

const validSleep = ({ date, sleepMinutes }) =>
  Number.isInteger(sleepMinutes) && sleepMinutes > 0 &&
  !validateMetricValue('sleep_minutes', sleepMinutes) && !validateLocalDate(date);

function writeDeviceBiometric(userId, { date, source }, metric, value) {
  const entry = { userId, metric, localDate: date, value, unit: METRIC_UNITS[metric], source };
  return [
    prisma.biometricEntry.createMany({ data: [entry], skipDuplicates: true }),
    // Guard the update in the database so concurrent manual edits win too.
    prisma.biometricEntry.updateMany({
      where: {
        userId, metric: entry.metric, localDate: entry.localDate,
        source: { in: DAILY_ACTIVITY_SOURCES }, value: { not: entry.value },
      },
      data: { value: entry.value, source: entry.source },
    }),
  ];
}

// Older clients can send sleep alongside activity. Apply only measured fields
// so partial reads and missing device permissions preserve earlier totals.
export async function syncDailyActivityService(userId, rows) {
  validateSyncRows(rows);
  const activityWrites = rows.flatMap((row) => {
    const measured = Object.fromEntries(activityFields
      .filter((field) => row[field] != null)
      .map((field) => [field, row[field]]));
    if (Object.keys(measured).length === 0) return [];
    const data = { ...measured, source: row.source };
    return [prisma.dailyActivityMetric.upsert({
      where: { userId_date: { userId, date: row.date } },
      update: { ...data, syncedAt: new Date() },
      create: { userId, date: row.date, ...data },
    })];
  });
  const biometricWrites = rows.filter(validSleep)
    .flatMap((row) => writeDeviceBiometric(userId, row, 'sleep_minutes', row.sleepMinutes));
  if (activityWrites.length + biometricWrites.length === 0) return [];
  const results = await prisma.$transaction([...activityWrites, ...biometricWrites]);
  const changes = results.slice(activityWrites.length);
  if (changes.some(({ count }) => count > 0)) {
    emitJourneyInvalidate(userId);
    await invalidateBlendedScore(userId);
  }
  return results.slice(0, activityWrites.length);
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

// Multi-user read for booking-service's leaderboard score — daily step/activity
// rows for a set of users in a date range. Internal-only: the public surface
// stays strictly per-user via req.userId, and the score feed never needs to
// cross the gateway. Mirrors the public filter (date `from`/`to` are the same
// 'YYYY-MM-DD' strings DailyActivityMetric.date holds), just on `id IN (...)`.
export async function getDailyActivityForUsersService(userIds, { from, to } = {}) {
  return prisma.dailyActivityMetric.findMany({
    where: {
      userId: { in: userIds },
      ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { date: 'desc' },
  });
}
