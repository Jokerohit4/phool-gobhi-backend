// Item 9: GET /stats skips the biometric read and the exercise-name join, caches
// the session series 60s per user, and a workout finish evicts it. Export callers
// keep the old behaviour (default options). Cache forced ON for this file.
// Run with: node --experimental-test-module-mocks --test
process.env.HEALTH_CACHE_FORCE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

let rows = []; let sessionReads = 0; let bioReads = 0; let lastArgs;
let getStatsService, buildRangeSeriesService, emitJourneyInvalidate;
const day = (() => { const d = new Date(Date.now() + 330 * 60000); return d.toISOString().slice(0, 10); })();
const row = (id, sets) => ({
  id, localDate: day, startedAt: new Date(`${day}T04:00:00Z`), endedAt: new Date(`${day}T05:00:00Z`),
  type: 'strength', rpe: 7, gymId: null, bookingId: null,
  exercises: [{ exercise: { name: 'Bench', muscleGroup: 'chest' }, sets }],
});

test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { Prisma: {}, PrismaClient: class { constructor() {
    this.workoutSession = { findMany: async (a) => { sessionReads++; lastArgs = a; return rows; } };
    this.biometricEntry = { findMany: async () => { bioReads++; return [{ localDate: day, metric: 'weight', value: 70, unit: 'kg', source: 'manual' }]; } };
  } } } });
  ({ getStatsService } = await import('../services/statsService.js'));
  ({ buildRangeSeriesService } = await import('../services/exportService.js'));
  ({ emitJourneyInvalidate } = await import('../utils/journeyCacheBus.js'));
});

test('stats never reads biometrics; the export still does (default behaviour unchanged)', async () => {
  rows = [row(1, [{ weightKg: 100, reps: 5, completed: true }])];
  emitJourneyInvalidate(1); bioReads = 0;
  await getStatsService(1, '30d');
  assert.equal(bioReads, 0);
  assert.deepEqual(lastArgs.include.exercises.include, { sets: { select: { completed: true, weightKg: true, reps: true } } });
  const exp = await buildRangeSeriesService(1, {});
  assert.equal(bioReads, 1);
  assert.equal(exp.biometrics.length, 1);
  assert.ok(lastArgs.include.exercises.include.exercise, 'export keeps the exercise join');
});

test('slim series equals the full series for the session rows /stats uses', async () => {
  rows = [row(1, [{ weightKg: 100, reps: 5, completed: true }, { weightKg: 50, reps: 5, completed: false }])];
  const full = await buildRangeSeriesService(1, { from: day });
  const slim = await buildRangeSeriesService(1, { from: day }, { slim: true });
  assert.deepEqual(slim.sessions, full.sessions);
  assert.deepEqual(slim.biometrics, []);
});

test('60s per-user cache serves repeat reads (any range); workout finish evicts', async () => {
  rows = [row(1, [{ weightKg: 100, reps: 5, completed: true }])];
  emitJourneyInvalidate(1); emitJourneyInvalidate(2);
  sessionReads = 0;
  const a = await getStatsService(1, '30d');
  const b = await getStatsService(1, '7d');
  await getStatsService(1, '30d');
  assert.equal(sessionReads, 1, 'one DB read serves all ranges');
  assert.equal(a.kpi.sessions, 1); assert.equal(b.kpi.sessions, 1);
  rows = [row(1, [{ weightKg: 100, reps: 5, completed: true }]), row(2, [{ weightKg: 10, reps: 5, completed: true }])];
  assert.equal((await getStatsService(1, '30d')).kpi.sessions, 1, 'stale within TTL until an event');
  emitJourneyInvalidate(1);
  assert.equal((await getStatsService(1, '30d')).kpi.sessions, 2, 'finish -> evicted -> fresh');
  const n = sessionReads;
  emitJourneyInvalidate(2);
  await getStatsService(1, '30d');
  assert.equal(sessionReads, n, "another user's eviction does not touch this one");
});
