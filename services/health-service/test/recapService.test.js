// FR-13. The risky logic here is the week bucketing (Monday-start, matching
// challenge-service's streak weeks) and the anonymity guarantee — the payload
// must carry numbers only, never a name/gym/photo, since the card is meant to
// be shared. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let sessions = [];
let getWeeklyRecapService;

test('setup: mock prisma once, import recapService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = { findMany: async () => sessions };
        }
      },
      Prisma: {},
    },
  });
  ({ getWeeklyRecapService } = await import('../services/recapService.js'));
  assert.equal(typeof getWeeklyRecapService, 'function');
});

// 2026-09-08 is a Tuesday; its Monday-start week begins 2026-09-07.
const TUESDAY = '2026-09-08';

test('an empty week reports isEmpty rather than a card of zeroes', async () => {
  sessions = [];
  const recap = await getWeeklyRecapService(1, TUESDAY);
  assert.equal(recap.isEmpty, true);
  assert.equal(recap.sessions, 0);
  assert.equal(recap.avgRpe, null, 'no sessions means no average, not zero');
});

test('week bounds are Monday-start, matching the streak weeks', async () => {
  sessions = [];
  const recap = await getWeeklyRecapService(1, TUESDAY);
  assert.equal(recap.weekStart, '2026-09-07', 'Monday');
  assert.equal(recap.weekEnd, '2026-09-13', 'Sunday');
});

test('totals, best lift and the active-day strip are computed from completed sets', async () => {
  sessions = [
    {
      startedAt: new Date('2026-09-07T09:00:00Z'), // Monday -> index 0
      endedAt: new Date('2026-09-07T10:00:00Z'),
      rpe: 8,
      exercises: [
        {
          exercise: { name: 'Squat' },
          sets: [
            { weightKg: 120, reps: 5 },
            { weightKg: 140, reps: 3 },
          ],
        },
      ],
    },
    {
      startedAt: new Date('2026-09-09T09:00:00Z'), // Wednesday -> index 2
      endedAt: new Date('2026-09-09T09:30:00Z'),
      rpe: 6,
      exercises: [
        { exercise: { name: 'Bench Press' }, sets: [{ weightKg: 100, reps: 8 }] },
      ],
    },
  ];

  const recap = await getWeeklyRecapService(1, TUESDAY);
  assert.equal(recap.sessions, 2);
  assert.equal(recap.minutes, 90);
  // 120*5 + 140*3 + 100*8 = 600 + 420 + 800
  assert.equal(recap.volumeKg, 1820);
  assert.equal(recap.avgRpe, 7);
  assert.deepEqual(recap.bestLift, { exerciseName: 'Squat', weightKg: 140, reps: 3 });
  assert.deepEqual(recap.activeDays, [true, false, true, false, false, false, false]);
  assert.equal(recap.isEmpty, false);
});

test('the payload carries no identifying fields at all', async () => {
  sessions = [
    {
      startedAt: new Date('2026-09-07T09:00:00Z'),
      endedAt: new Date('2026-09-07T10:00:00Z'),
      rpe: 7,
      gymId: 9,
      bookingId: 100,
      exercises: [{ exercise: { name: 'Squat' }, sets: [{ weightKg: 100, reps: 5 }] }],
    },
  ];

  const recap = await getWeeklyRecapService(1, TUESDAY);
  const keys = Object.keys(recap);
  for (const forbidden of ['userId', 'gymId', 'bookingId', 'name', 'photoUrl']) {
    assert.ok(!keys.includes(forbidden), `recap must not expose ${forbidden}`);
  }
  // The one string it does carry is an exercise name, which is not PII.
  assert.equal(recap.bestLift.exerciseName, 'Squat');
});
