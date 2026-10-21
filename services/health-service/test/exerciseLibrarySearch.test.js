import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const rows = [
  { id: 1, name: 'Dumbbell Bench Press', muscleGroup: 'chest', equipment: 'dumbbell', createdByUserId: null },
  { id: 2, name: 'My Dumbbell Bench Press', muscleGroup: 'chest', equipment: 'dumbbell', createdByUserId: 7 },
  { id: 3, name: 'Private Dumbbell Bench Press', muscleGroup: 'chest', equipment: 'dumbbell', createdByUserId: 99 },
  { id: 4, name: 'Barbell Bench Press', muscleGroup: 'chest', equipment: 'barbell', createdByUserId: null },
];
let requested;
mock.module('@prisma/client', {
  namedExports: {
    PrismaClient: class {
      exercise = {
        findMany: async ({ where }) => {
          requested = where;
          const [scope, muscle, equipment] = where.AND;
          const userId = scope.OR[1].createdByUserId;
          return rows.filter((e) => (e.createdByUserId == null || e.createdByUserId === userId)
            && (!muscle.muscleGroup || e.muscleGroup === muscle.muscleGroup)
            && (!equipment.equipment || e.equipment === equipment.equipment));
        },
      };
    },
  },
});
const { searchExercisesService } = await import('../services/exerciseLibraryService.js');

test('aliases and typos retain user ownership and equipment/muscle filters', async () => {
  const matches = await searchExercisesService(7, { q: 'dumbell bench', muscleGroup: 'chest', equipment: 'dumbbell' });
  assert.deepEqual(requested.AND[0], { OR: [{ createdByUserId: null }, { createdByUserId: 7 }] });
  assert.deepEqual(matches.map((e) => e.id), [1, 2]);
});

test('exact names outrank other variants, and nonsense returns an empty array', async () => {
  assert.equal((await searchExercisesService(7, { q: 'Barbell Bench Press' }))[0].id, 4);
  assert.deepEqual(await searchExercisesService(7, { q: 'zzxxxyy' }), []);
});
