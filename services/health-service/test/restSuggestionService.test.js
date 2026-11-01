import { test } from 'node:test';
import assert from 'node:assert/strict';

let rest;
let rows = [];
let lastQuery;
let queries = 0;

test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class {}, Prisma: {} } });
  rest = await import('../services/restSuggestionService.js');
});

const sets = (...xs) => xs.map((restSeconds) => ({ restSeconds }));

test('computeSuggestedRest: mean, rounding to 5, clamping', () => {
  assert.deepEqual(rest.computeSuggestedRest({ history: sets(60, 90) }), { seconds: 75, samples: 2 });
  assert.equal(rest.computeSuggestedRest({ history: sets(62) }).seconds, 60);
  assert.equal(rest.computeSuggestedRest({ history: sets(63) }).seconds, 65);
  assert.equal(rest.computeSuggestedRest({ history: sets(10) }).seconds, 20);
  assert.equal(rest.computeSuggestedRest({ history: sets(600, 600) }).seconds, 300);
});

test('computeSuggestedRest: ignores nulls and outliers; empty -> null', () => {
  assert.deepEqual(rest.computeSuggestedRest({ history: sets(null, 4, 601, 60, undefined) }), { seconds: 60, samples: 1 });
  assert.equal(rest.computeSuggestedRest({ history: sets(null, 2, 900) }), null);
  assert.equal(rest.computeSuggestedRest({ history: [] }), null);
  assert.equal(rest.computeSuggestedRest({}), null);
});

// Fake db: evaluates the same filters the loader asks for.
const fakeDb = {
  sessionExercise: {
    findMany: async (q) => {
      queries++;
      lastQuery = q;
      const w = q.where;
      const hit = rows
        .filter((r) => w.exerciseId.in.includes(r.exerciseId)
          && r.session.userId === w.session.userId
          && (w.session.endedAt ? r.session.endedAt != null : true)
          && (!w.session.id || r.sessionId !== w.session.id.not))
        .sort((a, b) => b.session.startedAt - a.session.startedAt || b.id - a.id);
      const seen = new Set();
      return hit.filter((r) => (seen.has(r.exerciseId) ? false : seen.add(r.exerciseId)));
    },
  },
};
const row = (id, sessionId, exerciseId, day, ended, rests, userId = 1) => ({
  id, sessionId, exerciseId, sets: sets(...rests),
  session: { userId, startedAt: new Date(2026, 9, day), endedAt: ended ? new Date(2026, 9, day, 1) : null },
});

test('loadSuggestedRest: one query; excludes current + unfinished; most recent previous only', async () => {
  rows = [
    row(1, 10, 100, 1, true, [30, 30]),
    row(2, 11, 100, 5, true, [90, 90]),     // most recent finished previous
    row(3, 12, 100, 8, false, [10, 10]),    // unfinished: ignored
    row(4, 13, 100, 9, true, [200]),        // current session: excluded
    row(5, 14, 100, 6, true, [45], 2),      // other user
    row(6, 11, 200, 5, true, [null]),       // no samples -> absent
  ];
  queries = 0;
  const m = await rest.loadSuggestedRest(1, [100, 200, 300], { excludeSessionId: 13, db: fakeDb });
  assert.equal(queries, 1);
  assert.deepEqual(lastQuery.where.exerciseId.in.sort(), [100, 200, 300]);
  assert.deepEqual(m.get(100), { seconds: 90, samples: 2, basedOnSessionId: 11 });
  assert.equal(m.has(200), false);
  assert.equal(m.has(300), false);
  assert.equal((await rest.loadSuggestedRest(1, [], { db: fakeDb })).size, 0);
});
