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
    this.$queryRaw = async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('DISTINCT ON')) { // personal-records query
        log.push('prs:start'); args.prs = { sql, values }; await delay(5); log.push('prs:end'); return sets;
      }
      log.push('se:start'); args.se = { sql: strings.join('?'), values }; await delay(10); log.push('se:end');
      const max = new Map();
      for (const se of sessionExercises) {
        const g = se.exercise.muscleGroup;
        if (!max.has(g) || se.session.startedAt > max.get(g)) max.set(g, se.session.startedAt);
      }
      return [...max].map(([muscleGroup, lastTrainedAt]) => ({ muscleGroup, lastTrainedAt }));
    };
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
  // The SQL already returns the per-exercise bests, ordered and limited; the
  // service only maps them (float8/int4 -> numbers, key order preserved).
  sets = [
    { exerciseName: 'Bench', weightKg: 60, reps: 9 },
    { exerciseName: 'Curl', weightKg: 20, reps: 5 },
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
  assert.deepEqual(args.prs.values, [1, 5], 'userId and limit are bound parameters');
  assert.ok(args.prs.sql.includes('LIMIT ?'));
  assert.ok(args.prs.sql.includes('"completed"') && args.prs.sql.includes('"weightKg" IS NOT NULL') && args.prs.sql.includes('"reps" IS NOT NULL'));
  assert.ok(args.prs.sql.includes('ORDER BY "name", "score" DESC, "id" ASC'), 'best per name: max score, earliest set on a tie');
  assert.ok(args.prs.sql.includes('ORDER BY b."score" DESC, f."firstId" ASC'), 'final order: score desc, first-seen name first');
  assert.equal(JSON.stringify(out.personalRecords), JSON.stringify([
    { exerciseName: 'Bench', weightKg: 60, reps: 9 },
    { exerciseName: 'Curl', weightKg: 20, reps: 5 },
  ]));
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
  assert.ok(!/startedAt"\s*[<>]=?\s*\?/.test(args.se.sql), 'no time bound on the aggregate');
});

test('readiness: one grouped, user-scoped, parameterised query; most recent per group wins', async () => {
  reset();
  sessionExercises = [
    { exercise: { muscleGroup: 'back' }, session: { startedAt: new Date(Date.now() - 9 * 86400000) } },
    { exercise: { muscleGroup: 'back' }, session: { startedAt: new Date(Date.now() - 3 * 86400000) } },
  ];
  const out = await getMuscleReadinessService(42);
  assert.deepEqual(args.se.values, [42], 'userId is a bound parameter, not interpolated');
  assert.ok(args.se.sql.includes('MAX(s."startedAt")'));
  assert.ok(args.se.sql.includes('GROUP BY e."muscleGroup"'));
  assert.ok(args.se.sql.includes(`s."type" <> 'rest'`));
  assert.equal(out.readiness.find((r) => r.muscleGroup === 'back').daysSinceTrained, 3);
});
