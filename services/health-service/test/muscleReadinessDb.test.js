// Opt-in DB equivalence: the bounded last-trained aggregate behind
// GET /progress/muscle-readiness must produce exactly what the old
// whole-history findMany + JS loop produced. Disposable DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const USER = 9_410_001; const OTHER = 9_410_002; const EMPTY = 9_410_003;
const DAY = 24 * 60 * 60 * 1000;

test('muscle-readiness: SQL aggregate equals the old JS implementation', { skip: !url && 'requires explicit disposable TEST_DATABASE_URL opt-in' }, async () => {
  process.env.DATABASE_URL = url;
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: url });
  const { getMuscleReadinessService } = await import('../services/progressService.js');
  const { COUNTED_WORKOUT_WHERE } = await import('../utils/sessionDay.js');
  const realNow = Date.now;
  const exIds = [];
  try {
    await db.workoutSession.deleteMany({ where: { userId: { in: [USER, OTHER, EMPTY] } } });
    const mk = async (muscleGroup, name) => (await db.exercise.create({ data: { name, muscleGroup, equipment: 'other', loggingType: 'sets_reps_weight' } })).id;
    const ex = {};
    for (const g of ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'fullBody']) { ex[g] = await mk(g, `rd-${g}`); exIds.push(ex[g]); }
    const now = Date.UTC(2026, 10, 1, 12, 0, 0);
    const ago = (d) => new Date(now - d * DAY);
    // sessions: [userId, startedAt, endedAt, type, [[group, completedSet]]]
    const sessions = [
      [USER, ago(400), ago(400), 'strength', [['legs', true]]],       // very old counted: legs only here
      [USER, ago(30), ago(30), 'strength', [['chest', true], ['back', false]]],
      [USER, ago(1.2), ago(1.2), 'strength', [['chest', true]]],       // most recent chest
      [USER, ago(0.1), null, 'strength', [['arms', true]]],           // unfinished: ignored
      [USER, ago(0.2), ago(0.2), 'rest', [['core', true]]],           // rest: ignored
      [USER, ago(0.3), ago(0.3), 'strength', [['shoulders', false]]],  // no completed set: ignored
      [USER, ago(5), ago(5), null, [['cardio', true]]],               // null type: excluded (Prisma NOT <> semantics)
      [USER, ago(7), ago(7), 'strength', [['back', true], ['back', true]]], // dup group in one session
      [USER, ago(2), ago(2), 'strength', []],                          // no exercises: ignored
      [OTHER, ago(0.05), ago(0.05), 'strength', [['fullBody', true], ['arms', true]]], // other user
    ];
    for (const [userId, startedAt, endedAt, type, exs] of sessions) {
      const s = await db.workoutSession.create({ data: { userId, startedAt, endedAt, type } });
      let order = 0;
      for (const [g, done] of exs) {
        const se = await db.sessionExercise.create({ data: { sessionId: s.id, exerciseId: ex[g], order: order++ } });
        await db.workoutSet.create({ data: { sessionExerciseId: se.id, setNumber: 1, weightKg: 10, reps: 5, completed: done } });
      }
    }

    // Reference: the old implementation (whole history, JS loop), verbatim logic.
    const WINDOWS = { chest: 2, back: 2, shoulders: 2, arms: 1, legs: 3, core: 1, cardio: 1, fullBody: 2 };
    async function reference(userId) {
      const rows = await db.sessionExercise.findMany({
        where: { session: { userId, ...COUNTED_WORKOUT_WHERE } },
        include: { exercise: { select: { muscleGroup: true } }, session: { select: { startedAt: true } } },
      });
      const lastTrainedAt = {};
      for (const se of rows) {
        const g = se.exercise.muscleGroup; const t = se.session.startedAt;
        if (!lastTrainedAt[g] || t > lastTrainedAt[g]) lastTrainedAt[g] = t;
      }
      const n = Date.now();
      const readiness = Object.keys(WINDOWS).map((muscleGroup) => {
        const last = lastTrainedAt[muscleGroup];
        const daysSince = last ? (n - new Date(last).getTime()) / DAY : Infinity;
        const status = daysSince >= WINDOWS[muscleGroup] ? 'ready' : 'recovering';
        return { muscleGroup, daysSinceTrained: last ? Math.round(daysSince) : null, status };
      });
      return { readiness, lastTrainedAt };
    }

    Date.now = () => now;
    for (const userId of [USER, OTHER, EMPTY]) {
      const want = await reference(userId);
      const got = await getMuscleReadinessService(userId);
      assert.deepEqual(got.readiness, want.readiness, `readiness for user ${userId}`);
      assert.equal(got.suggestedTemplate, null);
    }
    // Sanity that the fixture actually exercises the filters.
    const u = await reference(USER);
    assert.equal(u.lastTrainedAt.arms, undefined);
    assert.equal(u.lastTrainedAt.core, undefined);
    assert.equal(u.lastTrainedAt.shoulders, undefined);
    assert.equal(u.lastTrainedAt.cardio, undefined, 'null-type session is excluded by the old filter');
    assert.ok(u.lastTrainedAt.legs, 'old (400d) session still counts');
    assert.equal((await reference(EMPTY)).readiness.every((r) => r.daysSinceTrained === null), true);
  } finally {
    Date.now = realNow;
    await db.workoutSession.deleteMany({ where: { userId: { in: [USER, OTHER, EMPTY] } } });
    if (exIds.length) await db.exercise.deleteMany({ where: { id: { in: exIds } } });
    await db.$disconnect();
    const { default: shared } = await import('../db/prisma.js');
    await shared.$disconnect();
  }
});
