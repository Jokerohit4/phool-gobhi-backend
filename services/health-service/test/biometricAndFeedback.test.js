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
  validateMetricValue, validateLocalDate, validateUnit, METRIC_UNITS;
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
    validateMetricValue, validateLocalDate, validateUnit, METRIC_UNITS,
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

test('a wrong unit is rejected, not silently relabelled as the canonical one', async () => {
  // The canonical-unit write is not the same claim as "the value we received
  // was in that unit". A 68 kg person typing 150 lb used to get a clean 201 and
  // a stored 150 kg row that reads back as authoritative — and that row is
  // what computes the calorie target, 3396 instead of 2125 kcal.
  //
  // The service could convert, and deliberately does not: choosing which unit
  // the user meant is guessing from a typo, on a number that drives a medical-
  // adjacent suggestion. A 400 costs one retry and says what went wrong.
  resetFakes();
  await assert.rejects(
    () => upsertEntryService(1, { metric: 'weight', value: 150, unit: 'lb', localDate: '2026-09-08' }),
    (err) => err.status === 400 && /must be recorded in kg, not lb/.test(err.message),
  );
  assert.equal(entryRows.length, 0, 'a rejected unit must not leave a row');

  // Omitting the unit is still fine — the canonical unit is not a secret, and
  // most clients just send the number.
  await upsertEntryService(1, { metric: 'weight', value: 68, localDate: '2026-09-08' });
  assert.equal(entryRows.length, 1);
  assert.equal(entryRows[0].unit, 'kg');

  // The canonical unit sent explicitly is accepted, so a client that always
  // sends it is not broken by the check.
  await upsertEntryService(1, { metric: 'weight', value: 67.8, unit: 'kg', localDate: '2026-09-09' });
  assert.equal(entryRows.length, 2);

  // sleep in hours is the mix-up the bounds cannot catch, since 7 is inside
  // [0, 1440].
  assert.match(validateUnit('sleep_minutes', 'hours'), /minutes, not hours/);
  assert.equal(validateUnit('sleep_minutes', 'minutes'), null);
  assert.equal(validateUnit('sleep_minutes', undefined), null);
  assert.equal(validateUnit('weight', null), null);
});

test('a localDate that is not a real calendar date is rejected', async () => {
  // The shape check is not the whole check. /^\d{4}-\d{2}-\d{2}$/ accepts all of
  // these, and that matters because rows are keyed one-per-day and sort
  // lexically: 2026-02-31 becomes its own point on a chart between 28 Feb and
  // 1 Mar, and new Date('2026-02-31') rolls over to 3 March rather than failing,
  // so anything parsing it later reads a different day than was written.
  resetFakes();
  for (const bad of ['2026-02-31', '2026-13-45', '2026-00-00', '2026-04-31', '26-02-31', '2026-2-3']) {
    await assert.rejects(
      () => upsertEntryService(1, { metric: 'weight', value: 74, localDate: bad }),
      (err) => err.status === 400,
      `${bad} should be rejected`,
    );
  }
  assert.equal(entryRows.length, 0, 'no impossible date may leave a row');

  // Real dates around the boundaries still work, including a leap day.
  for (const good of ['2026-02-28', '2026-03-01', '2024-02-29']) {
    await upsertEntryService(1, { metric: 'weight', value: 74, localDate: good }, { today: '2026-09-28' });
  }
  assert.equal(entryRows.length, 3);
});

test('a future localDate is rejected at write time, not just ignored at read time', async () => {
  // targetService.latestWeightKg already skipped future-dated readings, which
  // is why this was invisible: the bad row was stored, listed in exports, drawn
  // on charts, and only quietly not used for the target. Rejecting it at the
  // write means the series never claims to contain a measurement that has not
  // happened.
  resetFakes();
  await assert.rejects(
    () => upsertEntryService(1, { metric: 'weight', value: 74, localDate: '2099-01-01' }),
    (err) => err.status === 400 && /cannot be in the future/.test(err.message),
  );
  assert.equal(entryRows.length, 0);

  // Today itself is fine — it is the same timezone-aware day the service
  // defaults to.
  await upsertEntryService(1, { metric: 'weight', value: 74, localDate: '2026-09-28' }, { today: '2026-09-28' });
  assert.equal(entryRows.length, 1);

  // Yesterday is fine, because a wearable sync can land after midnight local.
  await upsertEntryService(1, { metric: 'weight', value: 74, localDate: '2026-09-27' }, { today: '2026-09-28' });
  assert.equal(entryRows.length, 2);
});

test('a whole batch is rejected rather than partly saved', async () => {
  // upsertManyService writes entry by entry, so a bad entry at position two
  // would otherwise leave the first one committed. For a metric that decides a
  // calorie target, half a quick-add is worse than none: the user sees an
  // error and reasonably assumes nothing was saved.
  resetFakes();
  await assert.rejects(
    () => upsertManyService(1, [
      { metric: 'weight', value: 74.2, localDate: '2026-09-08' },
      { metric: 'resting_hr', value: 52, localDate: '2026-13-45' },
    ]),
    (err) => err.status === 400,
  );
  assert.equal(entryRows.length, 0, 'the valid entry before the bad one must not be committed');
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

test('steps writes are rejected outright — it is measured-only, single home is daily-activity', async () => {
  resetFakes();
  // Hand-typed, whatever the source: the device copy belongs in
  // DailyActivityMetric, never in biometricEntry, so no path may write it.
  await assert.rejects(
    () => upsertEntryService(1, { metric: 'steps', value: 8000, localDate: '2026-09-08' }),
    (err) => err.status === 400 && /measured automatically/.test(err.message),
  );
  await assert.rejects(
    () => upsertEntryService(1, {
      metric: 'steps', value: 8000, localDate: '2026-09-08', source: 'health_connect',
    }),
    (err) => err.status === 400,
  );
  assert.equal(entryRows.length, 0, 'a rejected steps write must not leave a row');
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
  await upsertEntryService(1, { metric: 'resting_hr', value: 52, localDate: '2026-09-07' });

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
