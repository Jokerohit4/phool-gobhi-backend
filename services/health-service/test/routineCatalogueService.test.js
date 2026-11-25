// The catalogue as users and staff meet it: the localized list, the server-side
// clone, the legacy template list older apps depend on, and the admin save
// rules (validation, concurrency, publish). Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LIBRARY = [
  { id: 1, name: 'Barbell Bench Press', loggingType: 'sets_reps_weight', equipment: 'barbell', createdByUserId: null },
  { id: 2, name: 'Push-up', loggingType: 'sets_reps_weight', equipment: 'bodyweight', createdByUserId: null },
  { id: 3, name: 'Plank', loggingType: 'duration', equipment: 'bodyweight', createdByUserId: null },
  { id: 4, name: 'March in Place', loggingType: 'duration', equipment: 'bodyweight', createdByUserId: null },
  { id: 5, name: 'My custom move', loggingType: 'sets_reps_weight', equipment: 'bodyweight', createdByUserId: 99 },
];
const libById = new Map(LIBRARY.map((e) => [e.id, e]));

let templates = [];
let nextId = 1;
let tick = 0;
let homeProfile = null;
const stamp = () => new Date(Date.UTC(2026, 10, 28, 0, 0, 0) + (++tick) * 1000);

const row = (o) => ({
  id: nextId++, userId: null, isSystem: true, isPublished: true, legacyListed: false, key: null,
  category: 'push', goal: 'muscleBuilding', level: 'beginner', sortOrder: 0, version: 1,
  description: null, estMinutes: 45, updatedAt: stamp(), texts: [], exercises: [], ...o,
});
const exRow = (exerciseId, order, o = {}) => ({
  exerciseId, order, phase: 'main', targetSets: 3, targetReps: 10, targetDurationSeconds: null,
  restSeconds: 60, instructions: null, supersetGroup: null, repMin: null, repMax: null, targetWeightKg: null,
  exercise: libById.get(exerciseId), ...o,
});
const txt = (lang, name, description = null, guidance = null) => ({ lang, name, description, guidance });

function matches(t, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') { if (!v.some((w) => matches(t, w))) return false; continue; }
    const actual = t[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v && actual === v.not) return false;
      if ('in' in v && !v.in.includes(actual)) return false;
    } else if (v instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== v.getTime()) return false;
    } else if (actual !== v) return false;
  }
  return true;
}
const withInclude = (t, include) => {
  if (!include) { const { texts, exercises, ...rest } = t; return rest; }
  const out = { ...t };
  if (!include.texts) delete out.texts;
  if (!include.exercises) delete out.exercises;
  return out;
};
const sorted = (rows, orderBy) => {
  const by = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const o of by) {
      const [f, dir] = Object.entries(o)[0];
      const c = a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0;
      if (c) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
};

let listCatalogueService, cloneTemplateService, catalogueCache;
let adminSaveTemplateService, adminListTemplatesService, adminGetTemplateService;
let listTemplatesService;
let evicted;

test('setup: mock prisma once, import the services once', async (t) => {
  t.mock.module('../services/plan/layerState.js', { exports: { getOnLayerKeys: async () => [] } });
  t.mock.module('../services/plan/rebuildPlan.js', { exports: { rebuildPlan: async () => {} } });
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.$transaction = async (fn) => fn(this);
          this.workoutTemplate = {
            findMany: async ({ where, include, orderBy }) =>
              sorted(templates.filter((x) => matches(x, where)), orderBy).map((x) => withInclude(x, include)),
            findFirst: async ({ where, include }) => {
              const found = templates.find((x) => matches(x, where));
              return found ? withInclude(found, include) : null;
            },
            findUnique: async ({ where, include }) => {
              const found = templates.find((x) => matches(x, where));
              return found ? withInclude(found, include) : null;
            },
            create: async ({ data, include }) => {
              const { exercises, texts, ...rest } = data;
              // Column defaults as in the schema: isSystem false, isPublished true.
              const created = row({
                isSystem: false, userId: null,
                ...rest,
                exercises: (exercises?.create ?? []).map((e) => ({ ...e, exercise: libById.get(e.exerciseId) })),
                texts: texts?.create ?? [],
              });
              templates.push(created);
              return withInclude(created, include);
            },
            update: async ({ where, data }) => {
              const target = templates.find((x) => x.id === where.id);
              const { version, ...rest } = data;
              Object.assign(target, rest, { updatedAt: stamp() });
              if (version?.increment) target.version += version.increment;
              return target;
            },
            updateMany: async ({ where, data }) => {
              const hit = templates.filter((x) => matches(x, where));
              for (const x of hit) Object.assign(x, data, { updatedAt: stamp() });
              return { count: hit.length };
            },
          };
          this.templateExercise = {
            deleteMany: async ({ where }) => {
              templates.find((x) => x.id === where.templateId).exercises = [];
            },
            createMany: async ({ data }) => {
              const target = templates.find((x) => x.id === data[0].templateId);
              target.exercises = data.map((d) => ({ ...d, exercise: libById.get(d.exerciseId) }));
            },
          };
          this.workoutTemplateText = {
            deleteMany: async ({ where }) => {
              const target = templates.find((x) => x.id === where.templateId);
              target.texts = target.texts.filter((x) => x.lang !== where.lang);
            },
            upsert: async ({ where, create, update }) => {
              const target = templates.find((x) => x.id === where.templateId_lang.templateId);
              const existing = target.texts.find((x) => x.lang === where.templateId_lang.lang);
              if (existing) Object.assign(existing, update); else target.texts.push({ ...create });
            },
          };
          this.exercise = {
            findMany: async ({ where }) => LIBRARY.filter((e) => where.id.in.includes(e.id) && e.createdByUserId === where.createdByUserId),
          };
          this.personalisationProfile = { findUnique: async () => homeProfile };
          this.workoutSession = { groupBy: async () => [] };
        }
      },
    },
  });
  ({ listCatalogueService, cloneTemplateService, catalogueCache } =
    await import('../services/routines/catalogueService.js'));
  ({ adminSaveTemplateService, adminListTemplatesService, adminGetTemplateService } =
    await import('../services/routines/catalogueAdminService.js'));
  ({ listTemplatesService } = await import('../services/templateService.js'));
  const realInvalidate = catalogueCache.invalidate.bind(catalogueCache);
  catalogueCache.invalidate = (key) => { evicted.push(key); return realInvalidate(key); };
});

function reset() {
  templates = []; nextId = 1; tick = 0; homeProfile = null; evicted = [];
}

function seedCatalogue() {
  reset();
  templates.push(
    row({ key: 'push_b', name: 'Push Day B', category: 'push', sortOrder: 20, legacyListed: true,
      texts: [txt('en', 'Push Day B', 'Chest · shoulders', 'Leave 1–3 reps in reserve.'),
              txt('hi', 'पुश डे बी', 'छाती · कंधे', 'रेप्स बचाएं।')],
      exercises: [exRow(4, 0, { phase: 'warm_up', targetReps: null, targetDurationSeconds: 120, restSeconds: 0 }),
                  exRow(1, 1), exRow(2, 2)] }),
    row({ key: 'bodyweight_flow', name: 'Bodyweight Flow', category: 'full_body', goal: 'beginner', sortOrder: 10,
      texts: [txt('en', 'Bodyweight Flow', 'No equipment')],
      exercises: [exRow(2, 0), exRow(3, 1, { targetReps: null, targetDurationSeconds: 30 })] }),
    row({ key: 'hidden', name: 'Hidden', isPublished: false, texts: [txt('en', 'Hidden')], exercises: [exRow(2, 0)] }),
    row({ key: null, userId: 7, isSystem: false, name: 'My own', exercises: [exRow(2, 0)] }),
    row({ key: null, name: 'Keyless system routine', exercises: [exRow(2, 0)] }),
  );
}

// ---- listing ------------------------------------------------------------------

test('the catalogue lists published keyed system routines in order, with location fit', async () => {
  seedCatalogue();
  const list = await listCatalogueService(7, 'en');
  assert.deepEqual(list.map((r) => r.key), ['bodyweight_flow', 'push_b']);
  const flow = list[0];
  assert.equal(flow.mainCount, 2);
  assert.equal(flow.isHomeRoutine, true);
  assert.equal(flow.needsGym, false);
  const push = list[1];
  assert.equal(push.mainCount, 2, 'warm-up rows are not counted');
  assert.equal(push.needsGym, true);
  assert.deepEqual(push.equipmentNeeded, ['full_home_gym']);
  assert.equal(push.texts, undefined, 'raw per-language rows are not leaked');
});

test('text comes back in the requested language, falling back to English', async () => {
  seedCatalogue();
  const hi = await listCatalogueService(7, 'hi');
  const pushHi = hi.find((r) => r.key === 'push_b');
  assert.equal(pushHi.name, 'पुश डे बी');
  assert.equal(pushHi.lang, 'hi');
  const flowHi = hi.find((r) => r.key === 'bodyweight_flow');
  assert.equal(flowHi.name, 'Bodyweight Flow', 'no Hindi text: English is served');
  assert.equal(flowHi.lang, 'en');
  const unknown = await listCatalogueService(7, 'klingon');
  assert.equal(unknown.find((r) => r.key === 'push_b').name, 'Push Day B');
});

test('the equipment fit badge follows the home setup, and is null until answered', async () => {
  seedCatalogue();
  assert.equal((await listCatalogueService(7, 'en'))[0].equipmentFit, null);
  homeProfile = { homeSetupAt: new Date(), homeEquipment: ['none'] };
  const list = await listCatalogueService(7, 'en');
  assert.deepEqual(list.find((r) => r.key === 'push_b').equipmentFit, { fits: false, missing: ['full_home_gym'] });
  assert.deepEqual(list.find((r) => r.key === 'bodyweight_flow').equipmentFit, { fits: true, missing: [] });
});

// ---- the plain template list older apps use ---------------------------------

test('the plain list keeps legacy-listed and keyless system routines, and hides the rest of the catalogue', async () => {
  seedCatalogue();
  const names = (await listTemplatesService(7)).map((t) => t.name).sort();
  // 'Bodyweight Flow' is catalogue-only, 'Hidden' is unpublished.
  assert.deepEqual(names, ['Keyless system routine', 'My own', 'Push Day B']);
});

test('scope=mine returns only the caller\'s own routines', async () => {
  seedCatalogue();
  const mine = await listTemplatesService(7, { scope: 'mine' });
  assert.deepEqual(mine.map((t) => t.name), ['My own']);
  assert.deepEqual(await listTemplatesService(8, { scope: 'mine' }), []);
});

// ---- clone --------------------------------------------------------------------

test('cloning copies a catalogue routine into the caller\'s own routines, independent of the source', async () => {
  seedCatalogue();
  const source = templates.find((x) => x.key === 'push_b');
  const copy = await cloneTemplateService(7, source.id, 'hi');
  assert.equal(copy.userId, 7);
  assert.equal(copy.isSystem, false);
  assert.equal(copy.key ?? null, null);
  assert.equal(copy.name, 'पुश डे बी');
  assert.equal(copy.description, 'छाती · कंधे. रेप्स बचाएं।');
  assert.equal(copy.category, 'push');
  assert.deepEqual(copy.exercises.map((e) => [e.phase, e.exerciseId, e.targetReps, e.targetDurationSeconds]), [
    ['warm_up', 4, null, 120], ['main', 1, 10, null], ['main', 2, 10, null],
  ]);
  // A later catalogue edit never reaches the copy.
  source.exercises = [];
  assert.equal(templates.find((x) => x.id === copy.id).exercises.length, 3);
});

test('only a published catalogue routine can be cloned', async () => {
  seedCatalogue();
  const own = templates.find((x) => x.name === 'My own');
  const hidden = templates.find((x) => x.key === 'hidden');
  await assert.rejects(() => cloneTemplateService(8, own.id, 'en'), { status: 404 });
  await assert.rejects(() => cloneTemplateService(8, hidden.id, 'en'), { status: 404 });
  await assert.rejects(() => cloneTemplateService(8, 9999, 'en'), { status: 404 });
});

// ---- admin ---------------------------------------------------------------------

const goodBody = (o = {}) => ({
  key: 'new_push', category: 'push', goal: 'muscleBuilding', level: 'beginner', sortOrder: 5,
  texts: { en: { name: 'New Push', description: 'Chest', guidance: 'Go steady.' } },
  exercises: [
    { exerciseId: 4, phase: 'warm_up', targetSets: 1, targetDurationSeconds: 120, restSeconds: 0 },
    { exerciseId: 1, targetSets: 3, targetReps: 8, restSeconds: 90 },
    { exerciseId: 3, targetSets: 2, targetDurationSeconds: 30, restSeconds: 45 },
  ],
  ...o,
});
const rejectsWith = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

test('staff can create a routine: estimate computed, author recorded, caches evicted', async () => {
  reset();
  const saved = await adminSaveTemplateService(42, goodBody());
  assert.equal(saved.key, 'new_push');
  assert.equal(saved.isSystem, true);
  assert.equal(saved.userId, null);
  assert.equal(saved.updatedBy, 42);
  assert.equal(saved.name, 'New Push');
  assert.ok(saved.estMinutes >= 5 && saved.estMinutes % 5 === 0);
  assert.equal(saved.legacyListed ?? false, false, 'new routines are catalogue-only');
  assert.deepEqual(saved.texts.map((x) => x.lang), ['en']);
  assert.ok(evicted.includes('catalogue'));
});

test('creating is validated: key, category, English text, exercises and their target types', async () => {
  reset();
  await rejectsWith(adminSaveTemplateService(1, goodBody({ key: 'Bad Key' })), 400, /key/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ category: 'chest' })), 400, /category/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ goal: 'bulk' })), 400, /goal/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ texts: { hi: { name: 'x' } } })), 400, /English text is required/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ texts: { en: { name: '' } } })), 400, /name is required/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ texts: { fr: { name: 'x' } } })), 400, /Unknown language/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ exercises: [{ exerciseId: 5, targetSets: 3, targetReps: 10 }] })), 400, /not in the exercise library/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ exercises: [{ exerciseId: 999, targetSets: 3, targetReps: 10 }] })), 400, /not in the exercise library/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ exercises: [{ exerciseId: 3, targetSets: 3, targetReps: 10 }] })), 400, /Plank is timed and needs a duration/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ exercises: [{ exerciseId: 1, targetSets: 3, targetDurationSeconds: 30 }] })), 400, /counted in reps and needs a rep target/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ exercises: [{ exerciseId: 4, phase: 'warm_up', targetSets: 1, targetDurationSeconds: 60 }] })), 400, /at least one main/);
  const seven = Array.from({ length: 7 }, () => ({ exerciseId: 2, targetSets: 3, targetReps: 10 }));
  await rejectsWith(adminSaveTemplateService(1, goodBody({ exercises: seven })), 400, /at most 6 main/);
  assert.equal(templates.length, 0, 'nothing was written by a rejected save');
});

test('a key or an English name already in use is refused', async () => {
  seedCatalogue();
  await rejectsWith(adminSaveTemplateService(1, goodBody({ key: 'push_b' })), 409, /key already exists/);
  await rejectsWith(adminSaveTemplateService(1, goodBody({ texts: { en: { name: 'Push Day B' } } })), 409, /English name already exists/);
});

test('updating replaces the exercise list, upserts translations and bumps the version', async () => {
  seedCatalogue();
  const target = templates.find((x) => x.key === 'bodyweight_flow');
  const saved = await adminSaveTemplateService(9, {
    texts: { en: { name: 'Bodyweight Flow', description: 'New wording' }, hi: { name: 'बॉडीवेट फ्लो' } },
    exercises: [{ exerciseId: 2, targetSets: 4, targetReps: 12 }],
    isPublished: true,
  }, target.id);
  assert.equal(saved.version, 2);
  assert.equal(saved.updatedBy, 9);
  assert.equal(saved.description, 'New wording');
  assert.equal(saved.exercises.length, 1);
  assert.equal(saved.exercises[0].targetSets, 4);
  assert.deepEqual(saved.texts.map((x) => x.lang).sort(), ['en', 'hi']);
  // Languages left out of the body are untouched; null removes one.
  const removed = await adminSaveTemplateService(9, { texts: { hi: null } }, target.id);
  assert.deepEqual(removed.texts.map((x) => x.lang), ['en']);
  await rejectsWith(adminSaveTemplateService(9, { texts: { en: null } }, target.id), 400, /English text cannot be removed/);
});

test('a routine can be unpublished (never deleted), and then leaves the catalogue', async () => {
  seedCatalogue();
  const target = templates.find((x) => x.key === 'push_b');
  await adminSaveTemplateService(9, { isPublished: false }, target.id);
  const list = await listCatalogueService(7, 'en');
  assert.deepEqual(list.map((r) => r.key), ['bodyweight_flow']);
  await assert.rejects(() => cloneTemplateService(7, target.id, 'en'), { status: 404 });
  // Staff still see it.
  assert.ok((await adminListTemplatesService()).some((x) => x.key === 'push_b'));
});

test('a stale form cannot overwrite a newer save: 409 with the current timestamp', async () => {
  seedCatalogue();
  const target = templates.find((x) => x.key === 'push_b');
  const loadedAt = (await adminGetTemplateService(target.id)).updatedAt.toISOString();
  // Someone else saves first.
  await adminSaveTemplateService(1, { sortOrder: 99 }, target.id);
  await assert.rejects(
    () => adminSaveTemplateService(2, { sortOrder: 1, expectedUpdatedAt: loadedAt }, target.id),
    (e) => e.status === 409 && e.errorCode === 'CONFIG_CONFLICT' && typeof e.currentUpdatedAt === 'string',
  );
  assert.equal(templates.find((x) => x.id === target.id).sortOrder, 99, 'the stale save wrote nothing');
  // With the fresh timestamp it goes through.
  const fresh = (await adminGetTemplateService(target.id)).updatedAt.toISOString();
  const ok = await adminSaveTemplateService(2, { sortOrder: 1, expectedUpdatedAt: fresh }, target.id);
  assert.equal(ok.sortOrder, 1);
  await rejectsWith(adminSaveTemplateService(2, { expectedUpdatedAt: 'not a date' }, target.id), 400, /ISO date/);
});

test('staff cannot reach a user\'s own routine through the admin routes', async () => {
  seedCatalogue();
  const own = templates.find((x) => x.name === 'My own');
  await rejectsWith(adminSaveTemplateService(1, { sortOrder: 1 }, own.id), 404, /not found/);
  await rejectsWith(adminGetTemplateService(own.id), 404, /not found/);
  assert.ok(!(await adminListTemplatesService()).some((x) => x.name === 'My own'));
});
