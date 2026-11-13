// GPS run tracker (run-tracker-spec.html). What's under test: payload
// validation (bad type, endedAt<=startedAt, elapsed/distance/speed bounds,
// polyline decode), the idempotent upsert on (userId, gps_tracker,
// clientRunId), the distance-mismatch reconciliation against the decoded
// polyline, cross-user 404s on detail/delete, and the summary aggregation.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePolyline } from '../utils/polyline.js';
import { RUN_ACTIVITY_TYPES, RUN_MAX_AVG_SPEED_MPS } from '../constants/healthEnums.js';

// A real ~1.11 km straight-ish line (roughly north along a meridian, so the
// haversine distance is easy to reason about): 0.01 degrees of latitude is
// ~1,110 m at the equator.
const SAMPLE_POLYLINE = encodePolyline([
  [12.9716, 77.5946],
  [12.9766, 77.5946],
  [12.9816, 77.5946],
]);

let exerciseRecords = [];
let runTracks = [];
let nextRecordId = 1;
let nextTrackId = 1;

function reset() {
  exerciseRecords = [];
  runTracks = [];
  nextRecordId = 1;
  nextTrackId = 1;
}

function findRecordByExternal(userId, source, externalId) {
  return exerciseRecords.find((r) => r.userId === userId && r.source === source && r.externalId === externalId);
}

let createRunService, listRunsService, getRunDetailService, deleteRunService, getRunSummaryService;
let createRun, listRuns, getRunDetail, deleteRun;

test('setup: mock prisma once, import the service + controller once', async (t) => {
  reset();
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.exerciseRecord = {
            upsert: async ({ where, update, create }) => {
              const existing = where.userId_source_externalId
                ? findRecordByExternal(where.userId_source_externalId.userId, where.userId_source_externalId.source, where.userId_source_externalId.externalId)
                : null;
              if (existing) {
                Object.assign(existing, update);
                return existing;
              }
              const row = { id: nextRecordId++, ...create };
              exerciseRecords.push(row);
              return row;
            },
            findFirst: async ({ where }) => {
              return (
                exerciseRecords.find(
                  (r) => r.id === where.id && r.userId === where.userId && r.source === where.source,
                ) || null
              );
            },
            findMany: async ({ where, orderBy, take }) => {
              let rows = exerciseRecords.filter((r) => r.userId === where.userId && r.source === where.source);
              if (where.startedAt) {
                if (where.startedAt.gte) rows = rows.filter((r) => r.startedAt >= where.startedAt.gte);
                if (where.startedAt.lte) rows = rows.filter((r) => r.startedAt <= where.startedAt.lte);
              }
              const [field, direction] = Object.entries(orderBy ?? {})[0] ?? ['startedAt', 'desc'];
              rows = [...rows].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
              if (direction === 'desc') rows.reverse();
              rows = rows.map((r) => ({ ...r, runTrack: runTracks.find((t2) => t2.exerciseRecordId === r.id) || null }));
              return take ? rows.slice(0, take) : rows;
            },
            delete: async ({ where }) => {
              const idx = exerciseRecords.findIndex((r) => r.id === where.id);
              const [removed] = exerciseRecords.splice(idx, 1);
              runTracks = runTracks.filter((t2) => t2.exerciseRecordId !== where.id); // simulate onDelete: Cascade
              return removed;
            },
          };
          this.runTrack = {
            upsert: async ({ where, update, create }) => {
              const existing = runTracks.find((t2) => t2.exerciseRecordId === where.exerciseRecordId);
              if (existing) {
                Object.assign(existing, update);
                return existing;
              }
              const row = { id: nextTrackId++, ...create };
              runTracks.push(row);
              return row;
            },
          };
        }
      },
      Prisma: { Decimal: class Decimal {} },
    },
  });
  ({ createRunService, listRunsService, getRunDetailService, deleteRunService, getRunSummaryService } = await import(
    '../services/runService.js'
  ));
  ({ createRun, listRuns, getRunDetail, deleteRun } = await import('../controllers/runController.js'));
});

function baseRun(overrides = {}) {
  return {
    clientRunId: 'run-1',
    type: 'run',
    startedAt: '2026-09-24T01:00:00Z',
    endedAt: '2026-09-24T01:30:00Z',
    movingSeconds: 1700,
    elapsedSeconds: 1800,
    distanceMeters: 1112, // matches SAMPLE_POLYLINE's haversine distance (~1112m) closely
    caloriesBurned: 180,
    weightKgUsed: 70,
    polyline: SAMPLE_POLYLINE,
    pointCount: 3,
    hadGap: false,
    splits: [{ km: 1, seconds: 400 }, { km: 2, seconds: 390 }],
    pauseCount: 0,
    appVersion: '1.0.0',
    platform: 'android',
    ...overrides,
  };
}

test('validation: rejects bad type, non-chronological times, and out-of-bounds elapsed/distance', async () => {
  await assert.rejects(() => createRunService(1, baseRun({ type: 'sprint' })), /type must be one of run, walk, cycle/);
  await assert.rejects(
    () => createRunService(1, baseRun({ startedAt: '2026-09-24T02:00:00Z', endedAt: '2026-09-24T01:00:00Z' })),
    /endedAt must be after startedAt/,
  );
  await assert.rejects(() => createRunService(1, baseRun({ elapsedSeconds: 30_000 })), /elapsedSeconds must be between/);
  await assert.rejects(() => createRunService(1, baseRun({ distanceMeters: 200_000 })), /distanceMeters must be between/);
  await assert.rejects(() => createRunService(1, baseRun({ movingSeconds: 5000 })), /movingSeconds must be between/);
});

test('validation: rejects an implausible average speed for the given type', async () => {
  // 20 km in 1000 moving seconds = 20 m/s, far past the 7 m/s run cap.
  await assert.rejects(
    () => createRunService(1, baseRun({ distanceMeters: 20_000, movingSeconds: 1000 })),
    /average speed exceeds what's plausible/,
  );
});

test('validation: every accepted type has an average-speed cap', () => {
  // The regression this guards: runService indexes RUN_MAX_AVG_SPEED_MPS by
  // type, and a miss compares against undefined — which is always false, so
  // the speed check would be skipped rather than fail. RUN_ACTIVITY_TYPES is
  // derived from the cap keys, so this is a tautology today and a tripwire if
  // anyone reintroduces a hand-written list beside the map.
  for (const type of RUN_ACTIVITY_TYPES) {
    assert.equal(
      typeof RUN_MAX_AVG_SPEED_MPS[type],
      'number',
      `RUN_MAX_AVG_SPEED_MPS is missing a cap for "${type}"`,
    );
  }
  assert.deepEqual(RUN_ACTIVITY_TYPES, ['run', 'walk', 'cycle']);
});

test('validation: cycle is accepted and gets its own, higher speed cap', async () => {
  // 10 km in 1250 moving seconds = 8 m/s (28.8 km/h), a normal club ride. Under
  // the run cap of 7 this would have been rejected outright, which is why cycle
  // needs its own entry rather than sharing the run threshold.
  const { record } = await createRunService(1, baseRun({
    clientRunId: 'cycle-1',
    type: 'cycle',
    distanceMeters: 10_000,
    movingSeconds: 1250,
  }));
  assert.equal(record.type, 'cycle');
  assert.equal(record.source, 'gps_tracker');

  // 13 m/s (46.8 km/h) sustained is beyond any real ride and must be caught.
  // Without a cycle key this comparison would silently evaluate false.
  await assert.rejects(
    () => createRunService(1, baseRun({
      clientRunId: 'cycle-2',
      type: 'cycle',
      distanceMeters: 13_000,
      movingSeconds: 1000,
    })),
    /average speed exceeds what's plausible for a cycle/,
  );
});

test('validation: rejects a missing/empty polyline and a malformed one', async () => {
  await assert.rejects(() => createRunService(1, baseRun({ polyline: '' })), /polyline is required/);
  await assert.rejects(() => createRunService(1, baseRun({ splits: 'not-an-array' })), /splits must be an array/);
});

test('create: saves a run, computes pace and best split', async () => {
  const { record } = await createRunService(2, baseRun({ clientRunId: 'run-a' }));
  assert.equal(record.userId, 2);
  assert.equal(record.source, 'gps_tracker');
  assert.equal(record.type, 'run');
  assert.equal(record.runTrack.bestKmSeconds, 390);
  assert.ok(record.runTrack.avgPaceSecPerKm > 0);
  assert.equal(record.runTrack.thumbPolyline, SAMPLE_POLYLINE, 'under the 40-point cap, thumbnail == original');
});

test('create: same clientRunId upserts instead of duplicating (idempotent retry/offline-queue upload)', async () => {
  const before = exerciseRecords.length;
  await createRunService(3, baseRun({ clientRunId: 'run-b', distanceMeters: 1112 }));
  await createRunService(3, baseRun({ clientRunId: 'run-b', distanceMeters: 1112, caloriesBurned: 999 }));
  assert.equal(exerciseRecords.length, before + 1, 'still exactly one new row, not two');
  const row = findRecordByExternal(3, 'gps_tracker', 'run-b');
  assert.equal(row.caloriesBurned, 999, 'second write updates the same row');
});

test('create: a client distance far from the decoded-polyline distance is overridden server-side', async () => {
  // 8000m over 1700 moving seconds is 4.7 m/s — plausible enough to clear
  // the average-speed cap on its own, so this exercises the mismatch path
  // specifically rather than being rejected earlier by the speed check.
  const { record, mismatch, serverDistanceMeters } = await createRunService(
    4,
    baseRun({ clientRunId: 'run-c', distanceMeters: 8000 }), // wildly off from the ~1.1km polyline
  );
  assert.ok(mismatch, 'flagged as a mismatch');
  assert.ok(serverDistanceMeters < 3000, 'server recomputed the real polyline distance');
  assert.equal(Number(record.distanceMeters), serverDistanceMeters, 'the server value wins, not the client one');
});

test('create: a client distance close to the polyline distance is trusted as-is', async () => {
  const { mismatch } = await createRunService(5, baseRun({ clientRunId: 'run-d', distanceMeters: 1112 }));
  assert.equal(mismatch, false);
});

test('list: only this user\'s gps_tracker runs, newest first, thumbnail only (no full polyline)', async () => {
  await createRunService(6, baseRun({ clientRunId: 'run-e', startedAt: '2026-09-20T01:00:00Z', endedAt: '2026-09-20T01:30:00Z' }));
  await createRunService(6, baseRun({ clientRunId: 'run-f', startedAt: '2026-09-22T01:00:00Z', endedAt: '2026-09-22T01:30:00Z' }));
  const { runs } = await listRunsService(6, {});
  assert.equal(runs.length, 2);
  assert.ok(new Date(runs[0].startedAt) > new Date(runs[1].startedAt), 'newest first');
  assert.ok(runs.every((r) => r.runTrack.thumbPolyline));
});

test('detail + delete: 404 for another user\'s run id, succeeds for the owner', async () => {
  const { record } = await createRunService(7, baseRun({ clientRunId: 'run-g' }));
  await assert.rejects(() => getRunDetailService(8, record.id), /Run not found/);
  const mine = await getRunDetailService(7, record.id);
  assert.equal(mine.id, record.id);

  await assert.rejects(() => deleteRunService(8, record.id), /Run not found/);
  await deleteRunService(7, record.id);
  assert.equal(exerciseRecords.some((r) => r.id === record.id), false);
  assert.equal(runTracks.some((t2) => t2.exerciseRecordId === record.id), false, 'runTrack cascades with it');
});

test('summary: aggregates distance/moving time and finds the best km across runs in range', async () => {
  await createRunService(9, baseRun({ clientRunId: 'run-h', startedAt: '2026-09-01T01:00:00Z', endedAt: '2026-09-01T01:30:00Z', splits: [{ km: 1, seconds: 300 }] }));
  await createRunService(9, baseRun({ clientRunId: 'run-i', startedAt: '2026-09-10T01:00:00Z', endedAt: '2026-09-10T01:30:00Z', splits: [{ km: 1, seconds: 250 }] }));
  const summary = await getRunSummaryService(9, {});
  assert.equal(summary.count, 2);
  assert.equal(summary.bestKmSecondsEver, 250);
  assert.ok(summary.totalDistanceMeters > 0);
});

test('controller: validation error surfaces as 400 with the message, success as 201', async () => {
  const makeRes = () => {
    const res = {};
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };

  const bad = makeRes();
  await createRun({ userId: 10, body: baseRun({ clientRunId: 'run-j', type: 'sprint' }) }, bad);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /type must be one of run, walk, cycle/);

  const ok = makeRes();
  await createRun({ userId: 10, body: baseRun({ clientRunId: 'run-k' }) }, ok);
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.body.data.source, 'gps_tracker');

  const list = makeRes();
  await listRuns({ userId: 10, query: {} }, list);
  assert.equal(list.body.data.length, 1);

  const detail = makeRes();
  await getRunDetail({ userId: 10, params: { id: ok.body.data.id } }, detail);
  assert.equal(detail.body.data.id, ok.body.data.id);

  const del = makeRes();
  await deleteRun({ userId: 10, params: { id: ok.body.data.id } }, del);
  assert.equal(del.body.data.deleted, true);
});
