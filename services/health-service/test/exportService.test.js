// Covers the CSV writer and the range-series shaping — the parts of FR-16
// with real logic (escaping, volume math, the two-table layout). The Prisma
// reads themselves are mocked; what's under test is the transformation.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let sessions = [];
let measurements = [];

let buildRangeSeriesService, seriesToCsv;

test('setup: mock prisma once, import exportService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = { findMany: async () => sessions };
          this.measurement = { findMany: async () => measurements };
        }
      },
      Prisma: {},
    },
  });
  ({ buildRangeSeriesService, seriesToCsv } = await import('../services/exportService.js'));
  assert.equal(typeof buildRangeSeriesService, 'function');
});

test('buildRangeSeries sums volume from completed weighted sets only', async () => {
  sessions = [
    {
      id: 1,
      localDate: '2026-09-08',
      startedAt: new Date('2026-09-08T09:00:00Z'),
      endedAt: new Date('2026-09-08T10:00:00Z'),
      type: 'strength',
      rpe: 7,
      gymId: 9,
      bookingId: 100,
      exercises: [
        {
          exercise: { name: 'Bench Press', muscleGroup: 'chest' },
          sets: [
            { completed: true, weightKg: 100, reps: 5 },
            // Not completed — must not count toward volume or set count.
            { completed: false, weightKg: 100, reps: 5 },
            // Completed but bodyweight (no weight/reps) — counts as a set,
            // contributes no volume.
            { completed: true, weightKg: null, reps: null },
          ],
        },
      ],
    },
  ];
  measurements = [];

  const series = await buildRangeSeriesService(1, {});
  const row = series.sessions[0];
  assert.equal(row.volumeKg, 500);
  assert.equal(row.completedSets, 2);
  assert.equal(row.durationMinutes, 60);
  assert.equal(row.type, 'strength');
  assert.equal(row.bookingId, 100);
});

test('buildRangeSeries converts measurement decimals to plain numbers', async () => {
  sessions = [];
  measurements = [{ localDate: '2026-09-08', weightKg: 74.2, bodyFatPct: 18.5 }];

  const series = await buildRangeSeriesService(1, {});
  assert.deepEqual(series.measurements, [
    { localDate: '2026-09-08', weightKg: 74.2, bodyFatPct: 18.5 },
  ]);
});

test('seriesToCsv emits both tables with headers', () => {
  const csv = seriesToCsv({
    sessions: [{ sessionId: 1, localDate: '2026-09-08', volumeKg: 500 }],
    measurements: [{ localDate: '2026-09-08', weightKg: 74.2, bodyFatPct: null }],
  });
  const lines = csv.split('\n');
  assert.equal(lines[0], '# sessions');
  assert.ok(lines[1].startsWith('sessionId,localDate'));
  assert.ok(lines[2].startsWith('1,2026-09-08'));
  assert.ok(csv.includes('# measurements'));
  // A null renders as an empty field, not the string "null".
  assert.ok(csv.includes('2026-09-08,74.2,'));
});

test('seriesToCsv quotes values containing commas or quotes', () => {
  const csv = seriesToCsv({
    sessions: [{ sessionId: 1, localDate: 'a,b', type: 'say "hi"' }],
    measurements: [],
  });
  assert.ok(csv.includes('"a,b"'), 'a comma-containing value must be quoted');
  assert.ok(csv.includes('"say ""hi"""'), 'embedded quotes must be doubled');
});
