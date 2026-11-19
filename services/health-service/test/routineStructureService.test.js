import { test } from 'node:test';
import assert from 'node:assert/strict';

let createdTemplate, updatedExercises, savedSession;
let deletions = 0;
let templateRows = [];
let templateOwner = 3;
const previousPhases = [];
const exercise = {
  findMany: async ({ where }) => {
    assert.deepEqual(where.OR, [{ createdByUserId: null }, { createdByUserId: 3 }]);
    return where.id.in.filter((id) => id === 1 || id === 2).map((id) => ({ id }));
  },
};
const tx = {
  exercise,
  templateExercise: {
    deleteMany: async () => { deletions++; },
    createMany: async ({ data }) => { updatedExercises = data; },
  },
  workoutTemplate: { update: async ({ data }) => data },
};

test('create, edit and start preserve routine phases, guidance, rest and timed targets', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class {
      constructor() {
        this.$transaction = async (callback) => callback(tx);
        this.exercise = exercise;
        this.workoutTemplate = {
          findUnique: async () => ({ id: 7, userId: templateOwner, isSystem: templateOwner === null, exercises: templateRows }),
          create: async ({ data }) => { createdTemplate = data; return data; },
        };
        this.workoutSession = { create: async ({ data }) => {
          savedSession = data;
          return { id: 8, userId: 3, startedAt: new Date(), exercises: data.exercises.create.map((e) => ({ ...e, sets: e.sets.create })) };
        } };
        this.sessionExercise = { findMany: async ({ where }) => { if (where.phase !== undefined) previousPhases.push(where.phase); return []; } };
      }
    } },
  });
  const { createTemplateService, updateTemplateService } = await import('../services/templateService.js');
  const { startSessionService } = await import('../services/workoutSessionService.js');
  const body = { name: 'Structured', description: 'Keep two reps in reserve', exercises: [
    { exerciseId: 1, phase: 'main', targetSets: 3, targetReps: 10, restSeconds: 120 },
    { exerciseId: 2, phase: 'cool_down', targetSets: 2, targetDurationSeconds: 30, restSeconds: 0, instructions: 'One side per set' },
    { exerciseId: 2, phase: 'warm_up', targetSets: 1, targetDurationSeconds: 300, restSeconds: 0, instructions: 'Start gently' },
  ] };
  await createTemplateService(3, body);
  assert.equal(createdTemplate.description, body.description);
  assert.deepEqual(createdTemplate.exercises.create.map((e) => e.phase), ['warm_up', 'main', 'cool_down']);
  await updateTemplateService(7, 3, body);
  assert.equal(deletions, 1);
  assert.equal(updatedExercises[2].instructions, 'One side per set');
  assert.equal(updatedExercises[2].restSeconds, 0);
  await assert.rejects(updateTemplateService(7, 3, { exercises: [] }), { status: 400 });
  const inaccessible = { name: 'Other', exercises: [{ exerciseId: 9, targetSets: 1, targetReps: 5 }] };
  await assert.rejects(createTemplateService(3, inaccessible), { status: 404 });
  await assert.rejects(updateTemplateService(7, 3, inaccessible), { status: 404 });
  assert.equal(deletions, 1, 'invalid edit must not delete the saved routine');
  templateRows = createdTemplate.exercises.create;
  const session = await startSessionService(3, 7);
  assert.equal(session.exercises[0].phase, 'warm_up');
  assert.equal(session.exercises[0].sets[0].durationSeconds, 300);
  assert.equal(session.exercises[1].sets[0].reps, 10);
  assert.equal(savedSession.exercises.create[2].restSeconds, 0);
  assert.equal(session.exercises[2].instructions, 'One side per set');
  assert.deepEqual(previousPhases, ['warm_up', 'main', 'cool_down']);
  templateOwner = null;
  assert.ok(await startSessionService(3, 7), 'shared system routines can start');
  templateOwner = 99;
  await assert.rejects(startSessionService(3, 7), { status: 404 }, 'private routines from another member stay inaccessible');
});
