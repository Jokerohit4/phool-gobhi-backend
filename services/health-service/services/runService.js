import { PrismaClient } from '@prisma/client';
import {
  RUN_MAX_ELAPSED_SECONDS,
  RUN_MAX_DISTANCE_METERS,
  RUN_MAX_AVG_SPEED_MPS,
  RUN_MAX_POLYLINE_BYTES,
  RUN_DISTANCE_MISMATCH_TOLERANCE,
} from '../constants/healthEnums.js';
import { decodePolyline, polylineDistanceMeters, thumbnailPolyline } from '../utils/polyline.js';

const prisma = new PrismaClient();

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// run-tracker-spec.html §10 "Server-side checks". Deliberately hand-rolled
// (no joi/zod anywhere in this backend, same convention activityService
// already follows) rather than a schema library for one endpoint.
function validateRunPayload(body) {
  const {
    clientRunId,
    type,
    startedAt,
    endedAt,
    movingSeconds,
    elapsedSeconds,
    distanceMeters,
    polyline,
    pointCount,
    splits,
  } = body || {};

  if (!clientRunId || typeof clientRunId !== 'string') {
    throw badRequest('clientRunId is required');
  }
  if (!['run', 'walk'].includes(type)) {
    throw badRequest('type must be run or walk');
  }
  if (!startedAt || !endedAt) {
    throw badRequest('startedAt and endedAt are required');
  }
  const started = new Date(startedAt);
  const ended = new Date(endedAt);
  if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()) || ended <= started) {
    throw badRequest('endedAt must be after startedAt');
  }
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || elapsedSeconds > RUN_MAX_ELAPSED_SECONDS) {
    throw badRequest(`elapsedSeconds must be between 0 and ${RUN_MAX_ELAPSED_SECONDS}`);
  }
  if (!Number.isFinite(movingSeconds) || movingSeconds < 0 || movingSeconds > elapsedSeconds) {
    throw badRequest('movingSeconds must be between 0 and elapsedSeconds');
  }
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0 || distanceMeters > RUN_MAX_DISTANCE_METERS) {
    throw badRequest(`distanceMeters must be between 0 and ${RUN_MAX_DISTANCE_METERS}`);
  }
  if (typeof polyline !== 'string' || polyline.length === 0) {
    throw badRequest('polyline is required');
  }
  if (Buffer.byteLength(polyline, 'utf8') > RUN_MAX_POLYLINE_BYTES) {
    throw badRequest('polyline exceeds the maximum size');
  }
  let decoded;
  try {
    decoded = decodePolyline(polyline);
  } catch {
    throw badRequest('polyline does not decode');
  }
  if (decoded.length === 0) {
    throw badRequest('polyline decodes to zero points');
  }
  if (!Number.isFinite(pointCount) || pointCount <= 0) {
    throw badRequest('pointCount is required');
  }
  if (!Array.isArray(splits)) {
    throw badRequest('splits must be an array');
  }
  for (const split of splits) {
    if (!Number.isFinite(split?.km) || !Number.isFinite(split?.seconds)) {
      throw badRequest('each split needs km and seconds');
    }
  }

  // Average-speed sanity check — catches a forgot-to-stop drive home, not a
  // determined cheat. movingSeconds could be 0 for a very short/instantly
  // finished run, so guard the division.
  if (movingSeconds > 0) {
    const avgSpeedMps = distanceMeters / movingSeconds;
    const cap = RUN_MAX_AVG_SPEED_MPS[type];
    if (avgSpeedMps > cap) {
      throw badRequest(`average speed exceeds what's plausible for a ${type} (${cap} m/s)`);
    }
  }

  return { started, ended, decoded };
}

// Recomputes distance from the polyline itself and only trusts the client's
// number if it's close. run-tracker-spec.html §10: "the server stores the
// server value and logs run_distance_mismatch" on disagreement beyond
// tolerance — the caller (controller) does the logging; this just returns
// which value won and whether it was a mismatch.
function reconcileDistance(clientDistanceMeters, polyline) {
  const serverDistanceMeters = polylineDistanceMeters(polyline);
  if (serverDistanceMeters === 0) return { distanceMeters: clientDistanceMeters, mismatch: false, serverDistanceMeters };
  const diff = Math.abs(clientDistanceMeters - serverDistanceMeters) / serverDistanceMeters;
  const mismatch = diff > RUN_DISTANCE_MISMATCH_TOLERANCE;
  return {
    distanceMeters: mismatch ? serverDistanceMeters : clientDistanceMeters,
    mismatch,
    serverDistanceMeters,
  };
}

function paceSecPerKm(distanceMeters, movingSeconds) {
  if (!distanceMeters || distanceMeters < 50) return null;
  return Math.round(movingSeconds / (distanceMeters / 1000));
}

// Upserts on (userId, source='gps_tracker', externalId=clientRunId), same
// idempotency shape activityService.createExerciseRecordService already
// uses for synced device workouts — a retried/offline-queued POST with the
// same clientRunId is a no-op, not a duplicate run.
export async function createRunService(userId, body) {
  const { started, ended, decoded } = validateRunPayload(body);
  const {
    clientRunId,
    type,
    movingSeconds,
    elapsedSeconds,
    distanceMeters: clientDistanceMeters,
    caloriesBurned,
    weightKgUsed,
    polyline,
    pointCount,
    hadGap,
    splits,
    pauseCount,
    appVersion,
    platform,
  } = body;

  const { distanceMeters, mismatch, serverDistanceMeters } = reconcileDistance(clientDistanceMeters, polyline);
  const thumbPolyline = thumbnailPolyline(polyline);
  const bestKmSeconds = splits.length ? Math.min(...splits.map((s) => s.seconds)) : null;

  const exerciseRecordData = {
    userId,
    source: 'gps_tracker',
    externalId: clientRunId,
    type,
    startedAt: started,
    endedAt: ended,
    durationSeconds: elapsedSeconds,
    caloriesBurned: caloriesBurned ?? null,
    distanceMeters,
    avgHeartRateBpm: null,
  };
  const runTrackData = {
    polyline,
    thumbPolyline,
    splits,
    movingSeconds,
    elapsedSeconds,
    avgPaceSecPerKm: paceSecPerKm(distanceMeters, movingSeconds),
    bestKmSeconds,
    pauseCount: pauseCount ?? 0,
    pointCount,
    hadGap: !!hadGap,
    weightKgUsed: weightKgUsed ?? null,
    appVersion: appVersion ?? null,
    platform: platform === 'ios' || platform === 'android' ? platform : null,
  };

  const record = await prisma.exerciseRecord.upsert({
    where: { userId_source_externalId: { userId, source: 'gps_tracker', externalId: clientRunId } },
    update: exerciseRecordData,
    create: exerciseRecordData,
  });

  const runTrack = await prisma.runTrack.upsert({
    where: { exerciseRecordId: record.id },
    update: runTrackData,
    create: { ...runTrackData, exerciseRecordId: record.id },
  });

  return { record: { ...record, runTrack }, mismatch, serverDistanceMeters, decodedPointCount: decoded.length };
}

// History list — never returns the full-resolution polyline (see the
// RunTrack schema comment); thumbPolyline only, for the route-shaped list
// icon in run-tracker-spec.html §04.
export async function listRunsService(userId, { cursor, limit = 20 } = {}) {
  const take = Math.min(Number(limit) || 20, 50);
  const records = await prisma.exerciseRecord.findMany({
    where: { userId, source: 'gps_tracker' },
    include: { runTrack: { select: { thumbPolyline: true, movingSeconds: true, avgPaceSecPerKm: true } } },
    orderBy: { startedAt: 'desc' },
    take: take + 1,
    ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {}),
  });
  const hasMore = records.length > take;
  const page = hasMore ? records.slice(0, take) : records;
  return {
    runs: page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export async function getRunDetailService(userId, id) {
  const record = await prisma.exerciseRecord.findFirst({
    where: { id: Number(id), userId, source: 'gps_tracker' },
    include: { runTrack: true },
  });
  if (!record) {
    const err = new Error('Run not found');
    err.status = 404;
    throw err;
  }
  return record;
}

export async function deleteRunService(userId, id) {
  const record = await prisma.exerciseRecord.findFirst({
    where: { id: Number(id), userId, source: 'gps_tracker' },
  });
  if (!record) {
    const err = new Error('Run not found');
    err.status = 404;
    throw err;
  }
  // runTrack cascades via the schema's onDelete: Cascade.
  await prisma.exerciseRecord.delete({ where: { id: record.id } });
  return { deleted: true };
}

// Totals for the month card + weekly ring (run-tracker-spec.html §04
// Summary/History). Personal bests are computed here rather than stored,
// so an edited/deleted run is never a stale PB left behind.
export async function getRunSummaryService(userId, { from, to } = {}) {
  const dateFilter = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;
  const records = await prisma.exerciseRecord.findMany({
    where: { userId, source: 'gps_tracker', ...(dateFilter ? { startedAt: dateFilter } : {}) },
    include: { runTrack: { select: { movingSeconds: true, bestKmSeconds: true } } },
    orderBy: { startedAt: 'asc' },
  });

  const totalDistanceMeters = records.reduce((sum, r) => sum + Number(r.distanceMeters ?? 0), 0);
  const totalMovingSeconds = records.reduce((sum, r) => sum + (r.runTrack?.movingSeconds ?? 0), 0);
  const bestKmSecondsEver = records.reduce((best, r) => {
    const v = r.runTrack?.bestKmSeconds;
    return v != null && (best == null || v < best) ? v : best;
  }, null);
  const longestDistanceMeters = records.reduce((max, r) => Math.max(max, Number(r.distanceMeters ?? 0)), 0);

  return {
    count: records.length,
    totalDistanceMeters,
    totalMovingSeconds,
    bestKmSecondsEver,
    longestDistanceMeters,
  };
}

// Used by exportService/adminService so those two never re-derive the
// gps_tracker filter themselves.
export const RUN_SOURCE = 'gps_tracker';
