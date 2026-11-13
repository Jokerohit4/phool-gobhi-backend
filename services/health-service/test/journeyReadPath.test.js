// journeyService read path (cache OFF — the test runner disables it by default):
//  - GET /journey and GET /plan/today are reads: a steady-state read must NOT write
//    (it used to UPDATE JourneyProgress on every call for any user with a
//    showed-up day, and parallel calls raced on the updatedAt guard);
//  - a changed lastShowedUpDate with no new unlock is still persisted;
//  - getJourneySummary no longer throws when the next locked layer is time-based
//    (it assigned to an undeclared `next`).
// Run with: node --experimental-test-module-mocks --test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const db = {};
let showedUp = [];
let updates;
let rebuilds;
let getJourney;
let getJourneySummary;

function reset() {
  db.progress = {
    userId: 1, startLevel: 'new_to_gym', startedAt: new Date(), wellnessOnly: false,
    unlocked: [{ layer: 1, at: new Date().toISOString(), via: 'start' }],
    foodEarlyAt: new Date(), // layer 2 unlocks "early" -> next locked layer is the elapsed_days "body" layer
    wellnessFocuses: [], lastShowedUpDate: null, updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  showedUp = ['2026-10-30'];
  updates = [];
  rebuilds = [];
}

test('setup: mock dependencies once, import the journey service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.journeyProgress = {
            findUnique: async () => (db.progress ? { ...db.progress } : null),
            update: async ({ data }) => {
              updates.push(data);
              Object.assign(db.progress, data);
              return { ...db.progress };
            },
          };
          const none = { findFirst: async () => null, findUnique: async () => null };
          this.foodLog = none; this.biometricEntry = none; this.healthProfile = none; this.medicalDocument = none;
        }
      },
    },
  });
  t.mock.module(new URL('../services/plan/rebuildPlan.js', import.meta.url).href, {
    exports: { rebuildPlan: async (_p, _u, opts) => { rebuilds.push(opts?.reason); } },
  });
  t.mock.module(new URL('../services/journey/showedUpDays.js', import.meta.url).href, {
    exports: { getShowedUpDays: async () => [...showedUp], getLastShowedUpDate: async () => showedUp[0] ?? null },
  });
  t.mock.module(new URL('../services/journey/referralHomeTrigger.js', import.meta.url).href, {
    exports: { checkAndTriggerHomeDaysReferral: async () => {} },
  });
  t.mock.module(new URL('../utils/fetchUserProfile.js', import.meta.url).href, {
    exports: { fetchUserProfileInternal: async () => ({}) },
  });
  // getJourneySummary imports this dynamically; file-level mock outlives the setup test.
  mock.module(new URL('../services/ledger/scoreService.js', import.meta.url).href, {
    exports: { weekDelta: async () => 4 },
  });
  ({ getJourney, getJourneySummary } = await import('../services/journey/journeyService.js'));
});

test('first read after a new unlock writes once and rebuilds the plan for it', async () => {
  reset();
  const journey = await getJourney(1);
  assert.equal(journey.layers.find((l) => l.layer === 2).unlocked, true);
  assert.equal(updates.length, 1, 'one write: the new unlock (lastShowedUpDate rides along)');
  assert.equal(updates[0].lastShowedUpDate, '2026-10-30');
  assert.deepEqual(rebuilds, ['unlock']);
});

test('steady-state reads do NOT write', async () => {
  reset();
  await getJourney(1); // settles the new unlock + lastShowedUpDate
  const writesAfterSettle = updates.length;
  for (let i = 0; i < 5; i++) await getJourney(1);
  assert.equal(updates.length, writesAfterSettle, 'five more reads, zero more writes');
  assert.deepEqual(rebuilds, ['unlock'], 'and no more plan rebuilds');
});

test('a new showed-up day with no new unlock still persists lastShowedUpDate (one write)', async () => {
  reset();
  await getJourney(1);
  const before = updates.length;
  showedUp = ['2026-10-31', '2026-10-30'];
  const journey = await getJourney(1);
  assert.equal(journey.showedUpDays, 2);
  assert.equal(updates.length, before + 1);
  assert.deepEqual(updates.at(-1), { lastShowedUpDate: '2026-10-31' });
  // ...and then it is steady again.
  await getJourney(1);
  assert.equal(updates.length, before + 1);
});

test('no journey -> null, no writes', async () => {
  reset();
  db.progress = null;
  assert.equal(await getJourney(1), null);
  assert.equal(updates.length, 0);
});

test('getJourneySummary reports the "body" layer as next (lookup was by row key, so it was always null)', async () => {
  reset();
  const summary = await getJourneySummary(1);
  assert.equal(summary.score.weekDelta, 4);
  assert.equal(summary.showedUpTotal, 1);
  assert.ok(summary.nextUnlock, 'next locked layer is reported');
  assert.match(summary.nextUnlock.label, /Layer 3 \(body\)/);
  assert.equal(summary.nextUnlock.need, 7);
  assert.equal(typeof summary.nextUnlock.have, 'number');
});

test('getJourney.next also reports the "body" layer', async () => {
  reset();
  const journey = await getJourney(1);
  assert.deepEqual(
    { layer: journey.next.layer, type: journey.next.type, need: journey.next.need },
    { layer: 3, type: 'elapsed_days', need: 7 },
  );
});

test('getJourneySummary with a later time-based layer next does not throw (was a ReferenceError)', async () => {
  reset();
  // 8 days in: body (7d) is unlocked, supplements (10d, elapsed_days) is next.
  db.progress.startedAt = new Date(Date.now() - 8 * 86400000);
  const summary = await getJourneySummary(1);
  assert.match(summary.nextUnlock.label, /Layer 4 \(supplements\)/);
  assert.equal(summary.nextUnlock.need, 10);
  assert.equal(summary.nextUnlock.have, 8);
});

test('getJourneySummary still 404s without a journey', async () => {
  reset();
  db.progress = null;
  await assert.rejects(getJourneySummary(1), (err) => err.status === 404 && err.code === 'JOURNEY_NOT_STARTED');
});
