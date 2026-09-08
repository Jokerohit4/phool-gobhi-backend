// FR-12 + FR-15 service logic: the upsert-per-day semantics (re-entering
// today's weight corrects rather than duplicates), partial updates that
// don't wipe the other field, and the suggestion action-rate math.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let measurementRows = [];
let feedbackRows = [];
let nextId = 1;

function resetFakes() {
  measurementRows = [];
  feedbackRows = [];
  nextId = 1;
}

let upsertMeasurementService, listMeasurementsService;
let recordImpressionService, recordVoteService, getFeedbackStatsService;

test('setup: mock prisma once, import the services once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.measurement = {
            upsert: async ({ where, create, update }) => {
              const { userId, localDate } = where.userId_localDate;
              const existing = measurementRows.find(
                (m) => m.userId === userId && m.localDate === localDate,
              );
              if (existing) {
                Object.assign(existing, update);
                return existing;
              }
              const row = { id: nextId++, ...create };
              measurementRows.push(row);
              return row;
            },
            findMany: async ({ where }) =>
              measurementRows.filter((m) => m.userId === where.userId),
            findUnique: async ({ where }) => {
              const { userId, localDate } = where.userId_localDate;
              return measurementRows.find((m) => m.userId === userId && m.localDate === localDate) || null;
            },
            delete: async ({ where }) => {
              measurementRows = measurementRows.filter((m) => m.id !== where.id);
            },
          };
          this.suggestionFeedback = {
            create: async ({ data }) => {
              const row = { id: nextId++, vote: null, ...data };
              feedbackRows.push(row);
              return row;
            },
            findUnique: async ({ where }) => feedbackRows.find((f) => f.id === where.id) || null,
            update: async ({ where, data }) => {
              const row = feedbackRows.find((f) => f.id === where.id);
              Object.assign(row, data);
              return row;
            },
            count: async () => feedbackRows.length,
            groupBy: async () => {
              const counts = {};
              for (const row of feedbackRows) {
                if (!row.vote) continue;
                counts[row.vote] = (counts[row.vote] || 0) + 1;
              }
              return Object.entries(counts).map(([vote, n]) => ({ vote, _count: { _all: n } }));
            },
          };
        }
      },
      Prisma: {},
    },
  });

  ({ upsertMeasurementService, listMeasurementsService } = await import(
    '../services/measurementService.js'
  ));
  ({ recordImpressionService, recordVoteService, getFeedbackStatsService } = await import(
    '../services/suggestionFeedbackService.js'
  ));
  assert.equal(typeof upsertMeasurementService, 'function');
});

test('logging a weight twice on the same day corrects it, no duplicate row', async () => {
  resetFakes();
  await upsertMeasurementService(1, { localDate: '2026-09-08', weightKg: 74.2 });
  await upsertMeasurementService(1, { localDate: '2026-09-08', weightKg: 74.6 });

  assert.equal(measurementRows.length, 1);
  assert.equal(measurementRows[0].weightKg, 74.6);
});

test('logging body-fat separately does not wipe the same day\'s weight', async () => {
  resetFakes();
  await upsertMeasurementService(1, { localDate: '2026-09-08', weightKg: 74.2 });
  await upsertMeasurementService(1, { localDate: '2026-09-08', bodyFatPct: 18 });

  assert.equal(measurementRows.length, 1);
  assert.equal(measurementRows[0].weightKg, 74.2, 'weight must survive a body-fat-only entry');
  assert.equal(measurementRows[0].bodyFatPct, 18);
});

test('a different day creates its own row', async () => {
  resetFakes();
  await upsertMeasurementService(1, { localDate: '2026-09-07', weightKg: 74.2 });
  await upsertMeasurementService(1, { localDate: '2026-09-08', weightKg: 74.6 });

  assert.equal(measurementRows.length, 2);
  const list = await listMeasurementsService(1);
  assert.equal(list.length, 2);
});

test('every shown suggestion is an impression, vote lands on that same row', async () => {
  resetFakes();
  const impression = await recordImpressionService(1, {
    suggestionKey: 'template:3',
    reasoning: { readyGroups: ['chest'] },
  });
  assert.equal(impression.vote, null, 'an impression starts unvoted');

  const voted = await recordVoteService(1, impression.id, 'up');
  assert.equal(voted.vote, 'up');
  assert.ok(voted.votedAt);
  assert.equal(feedbackRows.length, 1, 'voting must not create a second row');
});

test('re-voting overwrites rather than stacking a second data point', async () => {
  resetFakes();
  const impression = await recordImpressionService(1, { suggestionKey: 'rest' });
  await recordVoteService(1, impression.id, 'up');
  const flipped = await recordVoteService(1, impression.id, 'down');

  assert.equal(flipped.vote, 'down');
  assert.equal(feedbackRows.length, 1);
});

test('voting on someone else\'s impression is rejected', async () => {
  resetFakes();
  const impression = await recordImpressionService(1, { suggestionKey: 'rest' });
  await assert.rejects(() => recordVoteService(999, impression.id, 'up'), /not found/i);
});

test('action rate is votes over impressions, not votes over votes', async () => {
  resetFakes();
  const a = await recordImpressionService(1, { suggestionKey: 'template:1' });
  await recordImpressionService(1, { suggestionKey: 'template:2' });
  await recordImpressionService(1, { suggestionKey: 'template:3' });
  await recordImpressionService(1, { suggestionKey: 'template:4' });
  await recordVoteService(1, a.id, 'up');

  const stats = await getFeedbackStatsService();
  assert.equal(stats.shown, 4);
  assert.equal(stats.voted, 1);
  assert.equal(stats.actionRate, 25);
  assert.deepEqual(stats.votes, { up: 1 });
});

test('action rate is zero, not NaN, before anything has been shown', async () => {
  resetFakes();
  const stats = await getFeedbackStatsService();
  assert.equal(stats.shown, 0);
  assert.equal(stats.actionRate, 0);
});
