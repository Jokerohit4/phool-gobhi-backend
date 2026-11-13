// Items 10+11: GET /templates (one grouped last-done query, cached system
// templates) and GET /exercises (cached global catalogue). Cache forced ON.
// Run with: node --experimental-test-module-mocks --test
process.env.HEALTH_CACHE_FORCE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

let templates; let sessions; let exercises; let counts;
let listTemplatesService, systemTemplatesCache, searchExercisesService, systemExercisesCache;

test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { Prisma: {}, PrismaClient: class { constructor() {
    this.workoutTemplate = { findMany: async ({ where }) => {
      counts.templates.push(where);
      return where.userId !== undefined ? templates.filter((x) => x.userId === where.userId) : templates.filter((x) => x.isSystem);
    } };
    this.personalisationProfile = { findUnique: async () => null };
    this.workoutSession = {
      groupBy: async ({ by, where }) => {
        counts.groupBy.push({ by, where });
        const out = new Map();
        for (const s of sessions) {
          if (s.userId !== where.userId || !where.templateId.in.includes(s.templateId)) continue;
          if (!out.has(s.templateId) || s.startedAt > out.get(s.templateId)) out.set(s.templateId, s.startedAt);
        }
        return [...out].map(([templateId, startedAt]) => ({ templateId, _max: { startedAt } }));
      },
      findFirst: async () => { counts.findFirst++; return null; },
    };
    this.exercise = { findMany: async ({ where }) => {
      counts.exercise.push(where);
      if (where.createdByUserId === null) return exercises.filter((e) => e.createdByUserId == null);
      const uid = where.AND[0].createdByUserId;
      return exercises.filter((e) => e.createdByUserId === uid);
    } };
  } } } });
  ({ listTemplatesService, systemTemplatesCache } = await import('../services/templateService.js'));
  ({ searchExercisesService, systemExercisesCache } = await import('../services/exerciseLibraryService.js'));
});

const reset = () => {
  counts = { templates: [], groupBy: [], findFirst: 0, exercise: [] };
  systemTemplatesCache.clear(); systemExercisesCache.clear();
  templates = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, userId: null, isSystem: true, name: `Sys ${String(i).padStart(2, '0')}`, exercises: [] })),
    { id: 1, userId: 1, isSystem: false, name: 'Mine', updatedAt: new Date(), exercises: [] },
    { id: 2, userId: 2, isSystem: false, name: 'Other', updatedAt: new Date(), exercises: [] },
  ];
  sessions = [
    { templateId: 1, userId: 1, startedAt: new Date('2026-10-01') },
    { templateId: 1, userId: 1, startedAt: new Date('2026-10-09') },
    { templateId: 105, userId: 1, startedAt: new Date('2026-09-01') },
    { templateId: 105, userId: 2, startedAt: new Date('2026-10-20') },
  ];
  exercises = [
    { id: 1, name: 'Bench Press', muscleGroup: 'chest', equipment: 'barbell', createdByUserId: null },
    { id: 2, name: 'Squat', muscleGroup: 'legs', equipment: 'barbell', createdByUserId: null },
    { id: 3, name: 'My Fly', muscleGroup: 'chest', equipment: 'dumbbell', createdByUserId: 7 },
    { id: 4, name: 'Secret', muscleGroup: 'chest', equipment: 'dumbbell', createdByUserId: 8 },
  ];
};

test('templates: ONE grouped last-done query (no per-template findFirst); per-user, correct values', async () => {
  reset();
  const list = await listTemplatesService(1);
  assert.equal(list.length, 13);
  assert.equal(counts.findFirst, 0, 'was one query per template');
  assert.equal(counts.groupBy.length, 1);
  assert.deepEqual(counts.groupBy[0].where.userId, 1);
  const byId = Object.fromEntries(list.map((t) => [t.id, t.lastDoneAt]));
  assert.equal(byId[1].getTime(), new Date('2026-10-09').getTime(), 'latest of the user sessions');
  assert.equal(byId[105].getTime(), new Date('2026-09-01').getTime(), 'another user newer session on a shared system routine is not leaked');
  assert.equal(byId[100], null);
  assert.equal(list.some((t) => t.id === 2), false);
});

test('templates: system list cached for all users; each user own list always fresh', async () => {
  reset();
  await listTemplatesService(1);
  await listTemplatesService(2);
  await listTemplatesService(1);
  const systemReads = counts.templates.filter((w) => w.isSystem === true).length;
  const ownReads = counts.templates.filter((w) => w.userId !== undefined).length;
  assert.equal(systemReads, 1, 'system templates loaded once for all users');
  assert.equal(ownReads, 3);
});

test('templates: a user with no templates at all issues no last-done query', async () => {
  reset();
  templates = [];
  assert.deepEqual(await listTemplatesService(1), []);
  assert.equal(counts.groupBy.length, 0);
});

test('exercises: global catalogue cached, only the caller custom rows queried per request, filters + privacy preserved', async () => {
  reset();
  const a = await searchExercisesService(7, {});
  const b = await searchExercisesService(7, { muscleGroup: 'chest' });
  assert.deepEqual(a.map((e) => e.name), ['Bench Press', 'My Fly', 'Squat']);
  assert.deepEqual(b.map((e) => e.name), ['Bench Press', 'My Fly']);
  assert.equal(counts.exercise.filter((w) => w.createdByUserId === null).length, 1, 'catalogue read once');
  assert.equal(counts.exercise.filter((w) => w.AND).length, 2, 'custom rows read per request');
  assert.ok(![...a, ...b].some((e) => e.name === 'Secret'));
  const q = await searchExercisesService(7, { q: 'fly', equipment: 'dumbbell' });
  assert.deepEqual(q.map((e) => e.name), ['My Fly']);
  const none = await searchExercisesService(99, { equipment: 'dumbbell' });
  assert.deepEqual(none, []);
});
