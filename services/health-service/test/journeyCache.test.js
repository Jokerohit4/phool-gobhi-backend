// getJourney's in-process cache (forced ON for this file — the test runner
// disables it by default). Pinned:
//  - parallel callers share one computation (the app-launch fan-out);
//  - results are served from cache within the TTL, as independent copies;
//  - emitJourneyInvalidate (workout finish / consent erase / journey writes) evicts;
//  - "no journey" is never cached (starting one must show up immediately);
//  - a nested getJourney from inside the load (rebuildPlan -> getOnLayerKeys ->
//    getLayers -> getJourney) must not deadlock on its own in-flight load.
// Run with: node --experimental-test-module-mocks --test
process.env.HEALTH_CACHE_FORCE = '1';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const db = {};
let reads;
let nestedJourney = null; // set by a test to make rebuildPlan call back into getJourney
let getJourney;
let emitJourneyInvalidate;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function reset({ foodEarly = false } = {}) {
  db.progress = {
    userId: 1, startLevel: 'new_to_gym', startedAt: new Date(), wellnessOnly: false,
    unlocked: [{ layer: 1, at: new Date().toISOString(), via: 'start' }],
    foodEarlyAt: foodEarly ? new Date() : null,
    wellnessFocuses: [], lastShowedUpDate: null, updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  reads = 0;
  nestedJourney = null;
  // The cache outlives a single test: start each one cold.
  if (emitJourneyInvalidate) { emitJourneyInvalidate(1); emitJourneyInvalidate(2); }
}

test('setup: mock dependencies once, import the journey service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.journeyProgress = {
            findUnique: async () => { reads++; await tick(10); return db.progress ? { ...db.progress } : null; },
            update: async ({ data }) => { Object.assign(db.progress, data); return { ...db.progress }; },
          };
          const none = { findFirst: async () => null, findUnique: async () => null };
          this.foodLog = none; this.biometricEntry = none; this.healthProfile = none; this.medicalDocument = none;
        }
      },
    },
  });
  t.mock.module(new URL('../services/plan/rebuildPlan.js', import.meta.url).href, {
    exports: { rebuildPlan: async (_p, userId) => { if (nestedJourney) nestedJourney.result = await getJourney(userId); } },
  });
  t.mock.module(new URL('../services/journey/showedUpDays.js', import.meta.url).href, {
    exports: { getShowedUpDays: async () => [], getLastShowedUpDate: async () => null },
  });
  t.mock.module(new URL('../services/journey/referralHomeTrigger.js', import.meta.url).href, {
    exports: { checkAndTriggerHomeDaysReferral: async () => {} },
  });
  t.mock.module(new URL('../utils/fetchUserProfile.js', import.meta.url).href, {
    exports: { fetchUserProfileInternal: async () => ({}) },
  });
  ({ getJourney } = await import('../services/journey/journeyService.js'));
  ({ emitJourneyInvalidate } = await import('../utils/journeyCacheBus.js'));
});

test('parallel callers share ONE computation', async () => {
  reset();
  const [a, b, c] = await Promise.all([getJourney(1), getJourney(1), getJourney(1)]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('served from cache within the TTL, as independent copies', async () => {
  reset();
  const first = await getJourney(1);
  first.layers[0].unlocked = 'tampered';
  first.showedUpDates.push('1999-01-01');
  const second = await getJourney(1);
  assert.equal(reads, 1, 'second call did not recompute');
  assert.equal(second.layers[0].unlocked, true, 'caller mutation did not leak into the cache');
  assert.deepEqual(second.showedUpDates, []);
});

test('different users are cached separately', async () => {
  reset();
  await getJourney(1);
  await getJourney(2); // db.progress is shared by the mock, but it is a separate key -> a separate load
  assert.equal(reads, 2);
});

test('emitJourneyInvalidate evicts, so the next read recomputes', async () => {
  reset();
  await getJourney(1);
  emitJourneyInvalidate(1);
  await getJourney(1);
  assert.equal(reads, 2);
});

test('"no journey" is never cached — a just-started journey shows up at once', async () => {
  reset();
  db.progress = null;
  assert.equal(await getJourney(1), null);
  reset();
  assert.notEqual(await getJourney(1), null, 'no invalidation needed');
});

test('a nested getJourney from inside the load (rebuildPlan path) does not deadlock', async () => {
  reset({ foodEarly: true }); // layer 2 unlocks "early" -> syncUnlocks -> rebuildPlan -> getJourney
  nestedJourney = { result: undefined };
  const result = await Promise.race([
    getJourney(1),
    tick(2000).then(() => 'DEADLOCK'),
  ]);
  assert.notEqual(result, 'DEADLOCK', 'getJourney completed');
  assert.ok(nestedJourney.result, 'the nested call also completed');
  assert.equal(result.layers.find((l) => l.layer === 2).unlocked, true);
});
