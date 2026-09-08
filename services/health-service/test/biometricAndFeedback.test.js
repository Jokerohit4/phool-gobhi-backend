// Fitness+ FR-12 / Health+ FR-01 biometric entries + FR-15 suggestion
// feedback. What's under test: the upsert-per-(user,metric,day) semantics,
// that one metric never clobbers another on the same day, unit canonicality,
// bounds validation, the multi-metric quick-add, and the action-rate math.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let entryRows = [];
let feedbackRows = [];
let nextId = 1;

function resetFakes() {
  entryRows = [];
  feedbackRows = [];
  nextId = 1;
}

let upsertEntryService, upsertManyService, listEntriesService, latestByMetricService,
  validateMetricValue, METRIC_UNITS;
let recordImpressionService, recordVoteService, getFeedbackStatsService;

test('setup: mock prisma once, import the services once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.biometricEntry = {
            upsert: async ({ where, create, update }) => {
              const { userId, metric, localDate } = where.userId_metric_localDate;
              const existing = entryRows.find(
                (e) => e.userId === userId && e.metric === metric && e.localDate === localDate,
              );
              if (existing) {
                Object.assign(existing, update);
                return existing;
              }
              const row = { id: nextId++, ...create };
              entryRows.push(row);
              return row;
            },
            // orderBy is honoured rather than ignored: latestByMetricService
            // relies on "first row per metric wins" over a localDate-desc
            // sort, so a fake that returns insertion order would let that
            // function pass while being wrong against real Prisma.
            findMany: async ({ where, orderBy }) => {
              let rows = entryRows.filter((e) => e.userId === where.userId);
              if (where.metric?.in) rows = rows.filter((e) => where.metric.in.includes(e.metric));
              const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
              for (const clause of [...clauses].reverse()) {
                const [field, direction] = Object.entries(clause)[0];
                rows = [...rows].sort((a, b) => {
                  const cmp = String(a[field]).localeCompare(String(b[field]));
                  return direction === 'desc' ? -cmp : cmp;
                });
              }
              return rows;
            },
            findUnique: async ({ where }) => {
              const { userId, metric, localDate } = where.userId_metric_localDate;
              return entryRows.find(
                (e) => e.userId === userId && e.metric === metric && e.localDate === localDate,
              ) || null;
            },
            delete: async ({ where }) => {
              entryRows = entryRows.filter((e) => e.id !== where.id);
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

  ({
    upsertEntryService, upsertManyService, listEntriesService, latestByMetricService,
    validateMetricValue, METRIC_UNITS,
  } = await import('../services/biometricService.js'));
  ({ recordImpressionService, recordVoteService, getFeedbackStatsService } = await import(
    '../services/suggestionFeedbackService.js'
  ));
  assert.equal(typeof upsertEntryService, 'function');
});

test('logging a weight twice on the same day corrects it, no duplicate row', async () => {
  resetFakes();
  await upsertEntryService(1, { metric: 'weight', value: 74.2, localDate: '2026-09-08' });
  await upsertEntryService(1, { metric: 'weight', value: 74.6, localDate: '2026-09-08' });

  assert.equal(entryRows.length, 1);
  assert.equal(entryRows[0].value, 74.6);
});

test('a second metric on the same day is its own row, not a clobber', async () => {
  resetFakes();
  await upsertEntryService(1, { metric: 'weight', value: 74.2, localDate: '2026-09-08' });
  await upsertEntryService(1, { metric: 'body_fat', value: 18, localDate: '2026-09-08' });

  assert.equal(entryRows.length, 2);
  assert.equal(entryRows.find((e) => e.metric === 'weight').value, 74.2);
  assert.equal(entryRows.find((e) => e.metric === 'body_fat').value, 18);
});

test('the unit is set from the canonical map, never trusted from the caller', async () => {
  resetFakes();
  await upsertEntryService(1, { metric: 'sleep_minutes', value: 430, localDate: '2026-09-08' });
  assert.equal(entryRows[0].unit, 'minutes');
  assert.equal(METRIC_UNITS.weight, 'kg');
  assert.equal(METRIC_UNITS.hrv, 'ms');
});

test('source defaults to manual and is carried, so wearable sync later reuses the row', async () => {
  resetFakes();
  await upsertEntryService(1, { metric: 'resting_hr', value: 52, localDate: '2026-09-08' });
  assert.equal(entryRows[0].source, 'manual');

  await upsertEntryService(1, {
    metric: 'resting_hr', value: 51, localDate: '2026-09-08', source: 'healthkit',
  });
  assert.equal(entryRows.length, 1, 'a device value overwrites the same day, not a parallel row');
  assert.equal(entryRows[0].source, 'healthkit');
});

test('the multi-metric quick-add saves every metric in one call', async () => {
  resetFakes();
  const saved = await upsertManyService(1, [
    { metric: 'weight', value: 74.2 },
    { metric: 'sleep_minutes', value: 420 },
    { metric: 'resting_hr', value: 54 },
  ], { localDate: '2026-09-08' });

  assert.equal(saved.length, 3);
  assert.equal(entryRows.length, 3);
});

test('bounds reject unit mix-ups without commenting on the value', () => {
  assert.equal(validateMetricValue('weight', 74.2), null);
  // A weight in pounds.
  assert.ok(validateMetricValue('weight', 420));
  // Body fat entered as a fraction.
  assert.ok(validateMetricValue('body_fat', 0.18));
  // Sleep entered in hours instead of minutes is still in range (7), which
  // is exactly why the unit is server-canonical rather than client-supplied.
  assert.equal(validateMetricValue('sleep_minutes', 430), null);
  assert.ok(validateMetricValue('sleep_minutes', 2000));
  assert.ok(validateMetricValue('nonsense', 1));
});

test('listEntries can filter to one metric', async () => {
  resetFakes();
  await upsertEntryService(1, { metric: 'weight', value: 74.2, localDate: '2026-09-07' });
  await upsertEntryService(1, { metric: 'steps', value: 8000, localDate: '2026-09-07' });

  const all = await listEntriesService(1);
  assert.equal(all.length, 2);
  const weightOnly = await listEntriesService(1, { metric: 'weight' });
  assert.equal(weightOnly.length, 1);
  assert.equal(weightOnly[0].metric, 'weight');
});

test('latestByMetric returns the most recent value per metric', async () => {
  resetFakes();
  await upsertEntryService(1, { metric: 'weight', value: 75, localDate: '2026-09-06' });
  await upsertEntryService(1, { metric: 'weight', value: 74.2, localDate: '2026-09-08' });
  await upsertEntryService(1, { metric: 'body_fat', value: 18, localDate: '2026-09-07' });

  const latest = await latestByMetricService(1);
  assert.equal(latest.weight.value, 74.2);
  assert.equal(latest.body_fat.value, 18);
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
