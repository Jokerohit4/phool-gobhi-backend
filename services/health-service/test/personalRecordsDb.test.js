// Opt-in DB equivalence: the SQL personal-records query behind
// GET /progress/summary must return exactly what the old "read every completed
// set, pick bests in JS" implementation returned - including ties. Disposable DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const USER = 9_420_001; const OTHER = 9_420_002; const EMPTY = 9_420_003;

test('personal records: SQL equals the old JS implementation (ties, limits, filters)', { skip: !url && 'requires explicit disposable TEST_DATABASE_URL opt-in' }, async () => {
  process.env.DATABASE_URL = url;
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: url });
  const { getProgressSummaryService } = await import('../services/progressService.js');
  const exIds = [];
  try {
    await db.workoutSession.deleteMany({ where: { userId: { in: [USER, OTHER, EMPTY] } } });
    const mk = async (name, muscleGroup = 'chest') => {
      const id = (await db.exercise.create({ data: { name, muscleGroup, equipment: 'other', loggingType: 'sets_reps_weight' } })).id;
      exIds.push(id); return id;
    };
    const names = ['pr-A', 'pr-B', 'pr-C', 'pr-D', 'pr-E', 'pr-F', 'pr-G', 'pr-H', 'pr-I', 'pr-C2', 'pr-Float', 'pr-NoValid', 'pr-OtherOnly'];
    const ex = {}; for (const n of names) ex[n] = await mk(n);
    const dupId = await mk('pr-A', 'back'); // second exercise row with the SAME name: merges in the old code

    // [userId, exerciseId, [[weight, reps, completed], ...]] - inserted in this order.
    const plan = [
      // B appears first with a weak set, later beats itself: first-seen order is B, A, ...
      [USER, ex['pr-B'], [[10, 5, true]]],
      [USER, ex['pr-A'], [[50, 10, true], [100, 5, true], [200, 5, false], [60, 8, true]]], // 500 tie: 50x10 first
      [USER, ex['pr-B'], [[100, 5, true]]],                       // B best 500 -> ties with A across names
      [USER, ex['pr-C2'], [[10, 5, true], [40, 10, true]]],       // 400 ties pr-C ACROSS names; C2 first seen earlier
      [USER, ex['pr-C'], [[80, 5, true], [40, 10, true]]],        // 400 tie within C -> 80x5 first
      [USER, ex['pr-D'], [[30, 10, true]]],                       // 300
      [USER, ex['pr-E'], [[20, 10, true]]],                       // 200
      [USER, ex['pr-F'], [[10, 10, true]]],                       // 100
      [USER, ex['pr-G'], [[5, 10, true]]],                        // 50  (6th+ cut by limit)
      [USER, ex['pr-H'], [[2.5, 10, true]]],                      // 25
      [USER, ex['pr-I'], [[0, 10, true]]],                        // 0 weight, still eligible
      [USER, ex['pr-Float'], [[100.1, 3, true], [300.3, 1, true]]], // exact tie, but in float 100.1*3 < 300.3: JS picks the 2nd
      [USER, ex['pr-NoValid'], [[null, 5, true], [50, null, true], [50, 5, false]]], // none eligible
      [USER, dupId, [[75, 7, true]]],                             // same name as pr-A, 525 -> beats A
      [OTHER, ex['pr-OtherOnly'], [[500, 500, true]]],
      [OTHER, ex['pr-A'], [[1000, 10, true]]],
    ];
    for (const [userId, exerciseId, sets] of plan) {
      const s = await db.workoutSession.create({ data: { userId, endedAt: new Date() } });
      const se = await db.sessionExercise.create({ data: { sessionId: s.id, exerciseId, order: 0 } });
      let n = 1;
      for (const [w, r, c] of sets) await db.workoutSet.create({ data: { sessionExerciseId: se.id, setNumber: n++, weightKg: w, reps: r, completed: c } });
    }

    // Reference: the old implementation, verbatim (no orderBy, JS Map + sort + slice).
    async function reference(userId, limit = 5) {
      const sets = await db.workoutSet.findMany({
        where: { completed: true, weightKg: { not: null }, reps: { not: null }, sessionExercise: { session: { userId } } },
        select: { weightKg: true, reps: true, sessionExercise: { select: { exercise: { select: { name: true } } } } },
      });
      const best = new Map();
      for (const s of sets) {
        const name = s.sessionExercise.exercise.name;
        const weight = Number(s.weightKg);
        const ex0 = best.get(name);
        if (!ex0 || weight * s.reps > ex0.weightKg * ex0.reps) best.set(name, { exerciseName: name, weightKg: weight, reps: s.reps });
      }
      return [...best.values()].sort((a, b) => b.weightKg * b.reps - a.weightKg * a.reps).slice(0, limit);
    }

    for (const userId of [USER, OTHER, EMPTY]) {
      const want = await reference(userId);
      const got = (await getProgressSummaryService(userId, '4w')).personalRecords;
      assert.deepEqual(got, want, `personalRecords for user ${userId}`);
      assert.equal(JSON.stringify(got), JSON.stringify(want), `byte-identical for user ${userId}`);
    }
    // Fixture sanity: the interesting cases are really in play.
    const u = await reference(USER);
    assert.equal(u.length, 5);
    assert.deepEqual(u[0], { exerciseName: 'pr-A', weightKg: 75, reps: 7 }, 'same-name exercises merge');
    assert.deepEqual(u[1], { exerciseName: 'pr-B', weightKg: 100, reps: 5 }, 'B ranks below merged A by score');
    assert.deepEqual(u[4], { exerciseName: 'pr-Float', weightKg: 300.3, reps: 1 }, 'float8 (not exact numeric) comparison');
    assert.deepEqual(u.slice(2).map((r) => r.exerciseName), ['pr-C2', 'pr-C', 'pr-Float'], 'cross-name tie: first-seen name first');
    assert.deepEqual(u[3], { exerciseName: 'pr-C', weightKg: 80, reps: 5 }, 'within-name tie: first set (80x5) wins');
    assert.deepEqual((await reference(EMPTY)), []);
  } finally {
    await db.workoutSession.deleteMany({ where: { userId: { in: [USER, OTHER, EMPTY] } } });
    if (exIds.length) await db.exercise.deleteMany({ where: { id: { in: exIds } } });
    await db.$disconnect();
    const { default: shared } = await import('../db/prisma.js');
    await shared.$disconnect();
  }
});
