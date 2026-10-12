// The coach journey's beginner gym seeds (B7): four system WorkoutTemplates
// ported from the customer app's starter_templates.dart, so every gym slot
// the plan engine writes can point at a real template.
//
// The property that matters most is idempotency: the seed runs as a deploy
// step and may run again after any deploy, and a re-run must never duplicate
// rows or silently rewrite what users who already copied a template are
// following. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  seedBeginnerTemplates,
  BEGINNER_TEMPLATE_NAMES,
} from '../prisma/seedBeginnerTemplates.js';

// The exercise catalogue seed.js ships (the names the templates resolve by).
const EXERCISES = [
  'Leg Press', 'Cable Pull-Through', 'Barbell Bench Press', 'Seated Cable Row',
  'Overhead Press', 'Plank', 'Incline Dumbbell Press',
  'Cable Overhead Triceps Extension', 'Lateral Raise', 'Triceps Pushdown',
  'Barbell Squat', 'Deadlift', 'Calf Raise', 'Lat Pulldown', 'Barbell Row',
  'Face Pull', 'Cable Crunch',
].map((name, i) => ({
  id: 500 + i,
  name,
  loggingType: name === 'Plank' ? 'duration' : 'reps',
}));

function fakePrisma({ missingExercises = [] } = {}) {
  const templatesByName = new Map();
  const writes = [];
  let nextId = 900;
  return {
    writes,
    templatesByName,
    exercise: {
      findMany: async ({ where }) =>
        EXERCISES.filter((e) => where.name.in.includes(e.name) && !missingExercises.includes(e.name)),
    },
    workoutTemplate: {
      findFirst: async ({ where }) => templatesByName.get(where.name) ?? null,
      create: async ({ data }) => {
        const row = { id: nextId++, ...data };
        writes.push({ model: 'workoutTemplate.create', data });
        templatesByName.set(data.name, row);
        return row;
      },
    },
  };
}

test('the four starter routines are named, and Full Body x3 is the first', () => {
  assert.equal(BEGINNER_TEMPLATE_NAMES.length, 4);
  assert.equal(BEGINNER_TEMPLATE_NAMES[0], 'Full Body x3 — Beginner-friendly');
  assert.ok(BEGINNER_TEMPLATE_NAMES.includes('Push Day A'));
  assert.ok(BEGINNER_TEMPLATE_NAMES.includes('Leg Day'));
  assert.ok(BEGINNER_TEMPLATE_NAMES.includes('Upper & Abs'));
});

test('a first run creates all four templates as system rows at beginner level', async () => {
  const prisma = fakePrisma();
  const out = await seedBeginnerTemplates(prisma);

  assert.equal(out.created, 4);
  assert.equal(out.total, 4);
  for (const write of prisma.writes) {
    assert.equal(write.data.isSystem, true, 'starter templates must be system templates');
    assert.equal(write.data.userId, null, 'system templates belong to nobody');
    assert.equal(write.data.level, 'beginner');
    assert.ok(write.data.exercises.create.length >= 5, 'a starter routine with real content');
    for (const ex of write.data.exercises.create) {
      assert.ok(ex.exerciseId, 'every exercise row resolves to a seeded exercise');
      assert.ok(ex.targetSets > 0);
      assert.ok(ex.restSeconds != null);
    }
  }
});

test('re-running the seed creates nothing: idempotent by name, content untouched', async () => {
  const prisma = fakePrisma();
  await seedBeginnerTemplates(prisma);
  const firstRunWrites = prisma.writes.length;
  const snapshot = [...prisma.templatesByName.values()].map((t) => ({ id: t.id, name: t.name }));

  const again = await seedBeginnerTemplates(prisma);

  assert.equal(again.created, 0, 'a re-run must not duplicate templates');
  assert.equal(prisma.writes.length, firstRunWrites, 'a re-run must not write');
  assert.deepEqual(
    [...prisma.templatesByName.values()].map((t) => ({ id: t.id, name: t.name })),
    snapshot,
    'existing rows are left exactly as they were',
  );
});

test('the plank is a duration exercise: seconds, never reps', async () => {
  const prisma = fakePrisma();
  await seedBeginnerTemplates(prisma);

  const fullBody = prisma.templatesByName.get('Full Body x3 — Beginner-friendly');
  const plank = fullBody.exercises.create.find((e) => e.exerciseId === EXERCISES.find((x) => x.name === 'Plank').id);
  assert.ok(plank, 'plank missing from Full Body x3');
  assert.equal(plank.targetDurationSeconds, 30);
  assert.equal(plank.targetReps, null);

  // And a reps exercise never carries a duration.
  const legPress = fullBody.exercises.create.find((e) => e.exerciseId === EXERCISES.find((x) => x.name === 'Leg Press').id);
  assert.equal(legPress.targetReps, 10);
  assert.equal(legPress.targetDurationSeconds, null);
});

test('a missing exercise fails loudly with the fix in the message', async () => {
  const prisma = fakePrisma({ missingExercises: ['Cable Pull-Through'] });
  await assert.rejects(
    () => seedBeginnerTemplates(prisma),
    (err) => {
      assert.match(err.message, /Cable Pull-Through/);
      assert.match(err.message, /seed\.js/);
      return true;
    },
  );
  assert.equal(prisma.writes.length, 0, 'a half-resolvable catalogue must not seed half a routine');
});
