// Item 12: attachPreviousPerformance asks for ONE prior row per exercise
// (orderBy session.startedAt desc, take 1) instead of reading the exercise's whole
// history and sorting in JS. Output must equal the old "sort everything, take the
// first" result - including when the newest prior session has no completed sets
// (it still wins; we must not fall back to an older session).
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const at = (d) => new Date(`2026-10-${d}T05:00:00Z`);
let allRows; let queries; let getSessionDetailService;
const current = { id: 100, userId: 1, startedAt: at('20'), exercises: [
  { id: 1, exerciseId: 5, phase: 'main', sets: [{ id: 1, setNumber: 1 }, { id: 2, setNumber: 2 }] },
  { id: 2, exerciseId: 6, phase: 'main', sets: [{ id: 3, setNumber: 1 }] },
] };

function applyQuery({ where, orderBy, take }) {
  let rows = allRows.filter((r) => r.exerciseId === where.exerciseId && r.phase === where.phase
    && r.session.userId === where.session.userId && r.session.startedAt < where.session.startedAt.lt)
    .map((r) => ({ ...r, sets: r.sets.filter((s) => s.completed) }));
  if (orderBy) {
    rows = [...rows].sort((a, b) => (b.session.startedAt - a.session.startedAt) || (b.id - a.id));
  }
  return take ? rows.slice(0, take) : rows;
}

test('setup', async (t) => {
  t.mock.module('../services/routineJourneyService.js', { exports: { recordRoutineWorkout: async () => null } });
  t.mock.module('@prisma/client', { exports: { Prisma: {}, PrismaClient: class { constructor() {
    this.workoutSession = { findUnique: async () => current };
    // The batched rest-suggestion lookup (`distinct`) is a separate query; this
    // test is about the per-exercise previous-performance reads only.
    this.sessionExercise = { findMany: async (args) => { if (args.distinct) return []; queries.push(args); return applyQuery(args); } };
  } } } });
  ({ getSessionDetailService } = await import('../services/workoutSessionService.js'));
});

const set = (n, w, reps, completed = true) => ({ setNumber: n, weightKg: w, reps, completed });

// The pre-change algorithm, kept here as the oracle.
function oldPrevious(exerciseId, phase) {
  const prior = allRows.filter((r) => r.exerciseId === exerciseId && r.phase === phase && r.session.userId === 1
    && r.session.startedAt < current.startedAt).map((r) => ({ ...r, sets: r.sets.filter((s) => s.completed) }));
  const mostRecent = prior.sort((a, b) => b.session.startedAt - a.session.startedAt)[0];
  const out = {};
  for (const s of mostRecent?.sets || []) out[s.setNumber] = { weightKg: s.weightKg, reps: s.reps };
  return out;
}

test('same previous-performance map as the old read-everything version, one row requested per exercise', async () => {
  queries = [];
  allRows = [
    { id: 1, exerciseId: 5, phase: 'main', session: { userId: 1, startedAt: at('01') }, sets: [set(1, 40, 10), set(2, 40, 9)] },
    { id: 2, exerciseId: 5, phase: 'main', session: { userId: 1, startedAt: at('10') }, sets: [set(1, 50, 8), set(2, 52, 6, false)] },
    { id: 3, exerciseId: 5, phase: 'main', session: { userId: 1, startedAt: at('25') }, sets: [set(1, 99, 1)] }, // after this session: ignored
    { id: 4, exerciseId: 5, phase: 'main', session: { userId: 2, startedAt: at('15') }, sets: [set(1, 70, 5)] }, // other user
    // newest prior session for exercise 6 has NO completed sets -> previous stays empty
    { id: 5, exerciseId: 6, phase: 'main', session: { userId: 1, startedAt: at('02') }, sets: [set(1, 20, 12)] },
    { id: 6, exerciseId: 6, phase: 'main', session: { userId: 1, startedAt: at('12') }, sets: [set(1, 25, 10, false)] },
  ];
  const detail = await getSessionDetailService(100, 1);
  const [e5, e6] = detail.exercises;
  assert.deepEqual(e5.sets.map((s) => s.previous), [oldPrevious(5, 'main')[1], oldPrevious(5, 'main')[2] ?? null]);
  assert.deepEqual(e5.sets[0].previous, { weightKg: 50, reps: 8 });
  assert.equal(e5.sets[1].previous, null, 'the incomplete set 2 of the latest session is not a ghost value');
  assert.equal(e6.sets[0].previous, oldPrevious(6, 'main')[1] ?? null);
  assert.equal(e6.sets[0].previous, null);
  assert.equal(queries.length, 2);
  for (const q of queries) {
    assert.equal(q.take, 1);
    assert.deepEqual(q.orderBy, [{ session: { startedAt: 'desc' } }, { id: 'desc' }]);
  }
});
