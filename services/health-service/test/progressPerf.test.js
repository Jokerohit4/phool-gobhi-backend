// Items 7+8: progressService. /progress/summary runs sessions + PRs together with
// narrowed selects; /progress/muscle-readiness starts the template read inside the
// first Promise.all. (The 7-day bound on the readiness query was NOT applied: the
// output reports daysSinceTrained for sessions of any age - see the last test.)
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let log; let args; let sessions; let sets; let templates; let sessionExercises;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let getProgressSummaryService, getMuscleReadinessService;

test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { Prisma: {}, PrismaClient: class { constructor() {
    this.workoutSession = { findMany: async (a) => { log.push('sessions:start'); args.sessions = a; await delay(15); log.push('sessions:end'); return sessions; } };
    this.workoutSet = { findMany: async (a) => { log.push('prs:start'); args.sets = a; await delay(5); log.push('prs:end'); return sets; } };
    this.sessionExercise = { findMany: async (a) => { log.push('se:start'); args.se = a; await delay(10); log.push('se:end'); return sessionExercises; } };
    this.workoutTemplate = { findMany: async () => { log.push('tpl:start'); await delay(10); log.push('tpl:end'); return templates; } };
    this.personalisationProfile = { findUnique: async () => { log.push('profile'); return null; } };
    this.cycleTrackingProfile = { findUnique: async () => null };
  } } } });
  ({ getProgressSummaryService, getMuscleReadinessService } = await import('../services/progressService.js'));
});

const reset = () => { log = []; args = {}; sessions = []; sets = []; templates = []; sessionExercises = []; };

test('summary: PR read overlaps the sessions read; same numbers; narrowed selects', async () => {
  reset();
  sessions = [{
    localDate: '2026-10-28', startedAt: new Date('2026-10-28T05:00:00Z'), endedAt: new Date('2026-10-28T06:00:00Z'),
    exercises: [{ exercise: { muscleGroup: 'chest' }, sets: [{ weightKg: 50, reps: 10 }, { weightKg: 60, reps: 5 }] }],
  }];
  sets = [
    { weightKg: 50, reps: 10, sessionExercise: { exercise: { name: 'Bench' } } },
    { weightKg: 60, reps: 9, sessionExercise: { exercise: { name: 'Bench' } } },
    { weightKg: 20, reps: 5, sessionExercise: { exercise: { name: 'Curl' } } },
  ];
  const out = await getProgressSummaryService(1, '4w');
  assert.ok(log.indexOf('prs:start') < log.indexOf('sessions:end'), 'PRs started before sessions finished');
  assert.equal(out.totalWorkouts, 1);
  assert.equal(out.totalVolumeKg, 800);
  assert.deepEqual(out.muscleGroupSplit, [{ muscleGroup: 'chest', percent: 100 }]);
  assert.deepEqual(out.personalRecords, [
    { exerciseName: 'Bench', weightKg: 60, reps: 9 },
    { exerciseName: 'Curl', weightKg: 20, reps: 5 },
  ]);
  assert.deepEqual(args.sessions.include.exercises.include.exercise, { select: { muscleGroup: true } });
  assert.deepEqual(args.sets.select.sessionExercise, { select: { exercise: { select: { name: true } } } });
});

test('readiness: template read starts with the first batch, result unchanged', async () => {
  reset();
  templates = [{ id: 3, name: 'Push', exercises: [{ exercise: { muscleGroup: 'chest', equipment: null } }] }];
  const out = await getMuscleReadinessService(1);
  assert.ok(log.indexOf('tpl:start') < log.indexOf('se:end'), 'template read overlaps the session read');
  assert.deepEqual(out.suggestedTemplate, { id: 3, name: 'Push', exerciseCount: 1 });
  assert.equal(out.readiness.length, 8);
  reset();
  assert.equal((await getMuscleReadinessService(1)).suggestedTemplate, null);
});

test('readiness: old sessions still report daysSinceTrained, which is why the query is not time-bounded', async () => {
  reset();
  sessionExercises = [{ exercise: { muscleGroup: 'chest' }, session: { startedAt: new Date(Date.now() - 20 * 86400000) } }];
  const chest = (await getMuscleReadinessService(1)).readiness.find((r) => r.muscleGroup === 'chest');
  assert.equal(chest.daysSinceTrained, 20);
  assert.equal(chest.status, 'ready');
  assert.equal(args.se.where.session.startedAt, undefined);
});
