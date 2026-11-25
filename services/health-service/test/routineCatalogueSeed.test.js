// The catalogue seed runs on deploy and may run again after any deploy, so the
// property that matters is that it only ever CREATES: a re-run must not
// duplicate rows, rewrite exercises users have scheduled, or overwrite an
// admin's edit. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { seedRoutineCatalogue, catalogueExerciseNames } from '../services/routines/catalogueSeed.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const routines = read('../prisma/catalogue/routines.json').routines;
const library = read('../prisma/exerciseCatalogue.json').map((e, i) => ({ id: 1000 + i, ...e }));

function fakePrisma({ missing = [], preexisting = [] } = {}) {
  const templates = new Map(); // key -> row
  const texts = []; // { templateId, lang, ... }
  let nextId = 1;
  for (const row of preexisting) templates.set(row.key, { id: nextId++, isSystem: true, ...row });
  const db = {
    templates, texts,
    exercise: {
      findMany: async ({ where }) => library.filter((e) => where.name.in.includes(e.name) && !missing.includes(e.name)),
    },
    workoutTemplate: {
      findUnique: async ({ where }) => templates.get(where.key) ?? null,
      findFirst: async ({ where }) => [...templates.values()].find((t) => t.name === where.name && t.isSystem) ?? null,
      create: async ({ data }) => {
        const id = nextId++;
        const { exercises, texts: nested, ...rest } = data;
        const row = { id, ...rest, exercises: exercises.create, texts: nested.create };
        templates.set(rest.key, row);
        for (const t of nested.create) texts.push({ templateId: id, ...t });
        return row;
      },
    },
    workoutTemplateText: {
      findMany: async ({ where }) => texts.filter((t) => t.templateId === where.templateId).map((t) => ({ lang: t.lang })),
      createMany: async ({ data }) => { for (const d of data) texts.push(d); return { count: data.length }; },
    },
  };
  return db;
}

test('a first run creates every routine with warm-up, cool-down, translations and an estimate', async () => {
  const db = fakePrisma();
  const out = await seedRoutineCatalogue(db, routines);
  assert.equal(out.created, routines.length);
  assert.equal(db.templates.size, routines.length);
  const pushB = db.templates.get('gym_push_b');
  assert.equal(pushB.name, 'Push Day B');
  assert.equal(pushB.userId, null);
  assert.equal(pushB.isSystem, true);
  assert.equal(pushB.legacyListed, true);
  assert.equal(db.templates.get('dumbbell_push').legacyListed, false);
  assert.equal(pushB.estMinutes % 5, 0);
  assert.deepEqual([...new Set(pushB.exercises.map((e) => e.phase))], ['warm_up', 'main', 'cool_down']);
  assert.deepEqual(pushB.exercises.map((e) => e.order), pushB.exercises.map((_, i) => i));
  assert.deepEqual(pushB.texts.map((t) => t.lang).sort(), ['en', 'hi', 'hinglish']);
  // Reps-counted rows carry reps, timed rows carry a duration, never both.
  for (const e of pushB.exercises) assert.ok((e.targetReps == null) !== (e.targetDurationSeconds == null));
});

test('a second run is a no-op: nothing duplicated, nothing rewritten', async () => {
  const db = fakePrisma();
  await seedRoutineCatalogue(db, routines);
  const before = JSON.stringify([...db.templates.values()]);
  const textCount = db.texts.length;
  const again = await seedRoutineCatalogue(db, routines);
  assert.equal(again.created, 0);
  assert.equal(again.textsAdded, 0);
  assert.equal(db.templates.size, routines.length);
  assert.equal(db.texts.length, textCount);
  assert.equal(JSON.stringify([...db.templates.values()]), before);
});

test('an existing routine keeps its exercises and text, and only gains missing translations', async () => {
  const edited = { key: 'gym_starter_push_a', name: 'Push Day A (edited by staff)', exercises: [{ keep: 'me' }], description: 'staff wording' };
  const db = fakePrisma({ preexisting: [edited] });
  db.texts.push({ templateId: 1, lang: 'en', name: 'Push Day A (edited by staff)' });
  const out = await seedRoutineCatalogue(db, routines);
  const row = db.templates.get('gym_starter_push_a');
  assert.equal(row.name, 'Push Day A (edited by staff)');
  assert.deepEqual(row.exercises, [{ keep: 'me' }]);
  const rowTexts = db.texts.filter((t) => t.templateId === row.id);
  assert.equal(rowTexts.find((t) => t.lang === 'en').name, 'Push Day A (edited by staff)', 'English was not overwritten');
  assert.deepEqual(rowTexts.map((t) => t.lang).sort(), ['en', 'hi', 'hinglish']);
  assert.equal(out.created, routines.length - 1);
  assert.equal(out.textsAdded, 2);
});

test('a keyless system routine that already uses a name is left alone, not duplicated', async () => {
  const db = fakePrisma();
  db.templates.set('legacy_without_key', { id: 77, isSystem: true, name: 'Dumbbell Push', key: 'legacy_without_key' });
  const out = await seedRoutineCatalogue(db, routines);
  assert.deepEqual(out.skipped, ['dumbbell_push']);
  assert.equal(db.templates.has('dumbbell_push'), false);
});

test('a missing library exercise fails loudly before anything is written', async () => {
  const db = fakePrisma({ missing: ['Hack Squat'] });
  await assert.rejects(() => seedRoutineCatalogue(db, routines), /missing exercises \[Hack Squat\]/);
  assert.equal(db.templates.size, 0);
});

test('every name the seed resolves is collected up front, preparation included', () => {
  const names = catalogueExerciseNames(routines);
  for (const n of ['March in Place', 'Shoulder Circles', 'Calf Stretch', 'Hack Squat', 'Treadmill Walk']) {
    assert.ok(names.includes(n), n);
  }
});

test('bad data is rejected with the routine named', async () => {
  const bad = structuredClone(routines);
  bad[3].category = 'cardio-ish';
  await assert.rejects(() => seedRoutineCatalogue(fakePrisma(), bad), new RegExp(`"${bad[3].key}".*unknown category`));
  const dup = structuredClone(routines);
  dup[5].key = dup[4].key;
  await assert.rejects(() => seedRoutineCatalogue(fakePrisma(), dup), /duplicate key/);
});
