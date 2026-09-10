// The property that matters: the sweep touches purpose-limited telemetry
// ONLY. If it ever starts deleting a user's own training history on a timer,
// that's a product bug wearing a compliance costume — and if it ever touches
// a financial record, that's a different law broken.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let policyRow = null;
let deleteCalls = [];
let feedbackDeleted = 0;

let loadRetentionPolicy, updateRetentionPolicy, runRetentionSweepService, RETENTION_DEFAULTS;

test('setup: mock prisma once, import retentionService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.retentionPolicy = {
            findUnique: async () => policyRow,
            upsert: async ({ create, update }) => {
              policyRow = policyRow ? { ...policyRow, ...update } : { ...create };
              return policyRow;
            },
          };
          this.suggestionFeedback = {
            deleteMany: async ({ where }) => {
              deleteCalls.push({ model: 'suggestionFeedback', where });
              return { count: feedbackDeleted };
            },
          };
          // Deliberately present so a sweep that wrongly reached for them
          // would record the call and fail the assertions below, rather than
          // throwing an unrelated "undefined is not a function".
          this.workoutSession = {
            deleteMany: async ({ where }) => {
              deleteCalls.push({ model: 'workoutSession', where });
              return { count: 0 };
            },
          };
          this.biometricEntry = {
            deleteMany: async ({ where }) => {
              deleteCalls.push({ model: 'biometricEntry', where });
              return { count: 0 };
            },
          };
          this.personalisationProfile = {
            deleteMany: async ({ where }) => {
              deleteCalls.push({ model: 'personalisationProfile', where });
              return { count: 0 };
            },
          };
        }
      },
      Prisma: {},
    },
  });
  ({ loadRetentionPolicy, updateRetentionPolicy, runRetentionSweepService, RETENTION_DEFAULTS } =
    await import('../services/retentionService.js'));
  assert.equal(typeof runRetentionSweepService, 'function');
});

test('policy falls back to defaults when no row has been configured', async () => {
  policyRow = null;
  const policy = await loadRetentionPolicy();
  assert.equal(policy.suggestionFeedbackDays, RETENTION_DEFAULTS.suggestionFeedbackDays);
  assert.equal(policy.suggestionFeedbackDays, 180);
});

test('the sweep deletes telemetry and NOTHING else', async () => {
  policyRow = null;
  deleteCalls = [];
  feedbackDeleted = 7;

  const result = await runRetentionSweepService();

  assert.equal(result.deleted.suggestionFeedback, 7);
  assert.equal(deleteCalls.length, 1, 'exactly one model may be swept');
  assert.equal(deleteCalls[0].model, 'suggestionFeedback');

  const touched = deleteCalls.map((c) => c.model);
  for (const mustSurvive of ['workoutSession', 'biometricEntry', 'personalisationProfile']) {
    assert.ok(!touched.includes(mustSurvive),
        `${mustSurvive} is the user's own record — it goes with the account, never on a timer`);
  }
});

test('the sweep cuts off by age, using the configured window', async () => {
  policyRow = { id: 1, suggestionFeedbackDays: 30 };
  deleteCalls = [];
  feedbackDeleted = 0;

  const before = Date.now();
  await runRetentionSweepService();

  const cutoff = deleteCalls[0].where.shownAt.lt;
  const expected = before - 30 * 24 * 60 * 60 * 1000;
  // Within a few seconds of the expected 30-day boundary.
  assert.ok(Math.abs(cutoff.getTime() - expected) < 5000,
      `cutoff ${cutoff.toISOString()} should be ~30 days back`);
});

test('the sweep reports what it deliberately retained', async () => {
  policyRow = null;
  deleteCalls = [];
  const result = await runRetentionSweepService();

  // Stated in the response, not just a comment, so whoever reads the sweep
  // output can see what was left alone and why.
  assert.match(result.retainedByDesign.userOwnRecord, /deleted with the account/);
  assert.match(result.retainedByDesign.statutory, /never swept/);
});

test('a retention window below 30 days is rejected', async () => {
  policyRow = null;
  // Setting this to 0/1 would delete telemetry before it has been
  // aggregated, silently destroying the metric it exists to produce.
  await assert.rejects(() => updateRetentionPolicy({ suggestionFeedbackDays: 1 }, 9), /between 30 and 3650/);
  await assert.rejects(() => updateRetentionPolicy({ suggestionFeedbackDays: 0 }, 9), /between 30 and 3650/);
});

test('a valid window is persisted with who changed it', async () => {
  policyRow = null;
  const saved = await updateRetentionPolicy({ suggestionFeedbackDays: 365 }, 9);
  assert.equal(saved.suggestionFeedbackDays, 365);
  assert.equal(saved.updatedBy, 9);
});
