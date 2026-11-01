// Catalog seeding and the audience lookup used to cost an auth-service round trip
// and ~30 sequential queries on EVERY challenge/coin-catalog request. Pinned here
// (caching forced ON — the runner disables it by default):
//  - runAtMostEvery runs the task once per interval, shares one in-flight run,
//    never remembers a failure, and re-runs after the interval;
//  - the read-path audience lookup is cached briefly and single-flight, failures
//    are not cached, and the enroll path (uncached) always reads fresh.
// Run with: node --experimental-test-module-mocks --test
process.env.CHALLENGE_CACHE_FORCE = '1';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

let runAtMostEvery;
let loadChallengeAudience;
let loadChallengeAudienceCached;
let fetchCalls = 0;
let profileFor = (id) => ({ id, persona: 'own_gym' });
let fetchFails = false;

test('setup: stub the ID-token header and fetch, import the modules', async () => {
  mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  globalThis.fetch = async (url) => {
    fetchCalls++;
    await tick(10);
    if (fetchFails) return { ok: false, status: 500, json: async () => ({}) };
    const id = Number(String(url).split('/').pop());
    return { ok: true, status: 200, json: async () => profileFor(id) };
  };
  ({ runAtMostEvery } = await import('../utils/runAtMostEvery.js'));
  ({ loadChallengeAudience, loadChallengeAudienceCached } = await import('../services/challengeAudience.js'));
});

// --- runAtMostEvery ---------------------------------------------------------

test('the task runs once; later calls inside the interval skip it', async () => {
  let runs = 0;
  const seed = runAtMostEvery(60_000, async () => { runs++; });
  await seed(); await seed(); await seed();
  assert.equal(runs, 1);
});

test('concurrent callers share ONE run', async () => {
  let runs = 0;
  const seed = runAtMostEvery(60_000, async () => { runs++; await tick(20); });
  await Promise.all([seed(), seed(), seed(), seed()]);
  assert.equal(runs, 1);
});

test('a failed run reaches its caller and is NOT remembered — the next call retries', async () => {
  let runs = 0;
  const seed = runAtMostEvery(60_000, async () => { runs++; if (runs === 1) throw new Error('db down'); });
  await assert.rejects(seed(), /db down/);
  await seed(); // retried and succeeds
  await seed(); // now skipped
  assert.equal(runs, 2);
});

test('after the interval it runs again (a deleted seed row heals without a restart)', async () => {
  let runs = 0;
  const seed = runAtMostEvery(30, async () => { runs++; });
  await seed();
  await tick(50);
  await seed();
  assert.equal(runs, 2);
});

test('the default under the test runner is "run every time"', async () => {
  const saved = process.env.CHALLENGE_CACHE_FORCE;
  delete process.env.CHALLENGE_CACHE_FORCE;
  try {
    let runs = 0;
    const seed = runAtMostEvery(60_000, async () => { runs++; });
    await seed(); await seed();
    assert.equal(runs, 2, 'tests that reseed a fake DB between cases keep working');
  } finally {
    process.env.CHALLENGE_CACHE_FORCE = saved;
  }
});

// --- audience lookup --------------------------------------------------------

test('the cached lookup asks auth-service once per user within the TTL', async () => {
  fetchCalls = 0; fetchFails = false;
  assert.equal(await loadChallengeAudienceCached(101), 'own_gym');
  assert.equal(await loadChallengeAudienceCached(101), 'own_gym');
  assert.equal(fetchCalls, 1);
});

test('parallel callers share one lookup', async () => {
  fetchCalls = 0;
  const out = await Promise.all([102, 102, 102].map((id) => loadChallengeAudienceCached(id)));
  assert.deepEqual(out, ['own_gym', 'own_gym', 'own_gym']);
  assert.equal(fetchCalls, 1);
});

test('different users are looked up separately', async () => {
  fetchCalls = 0;
  profileFor = (id) => ({ id, persona: id === 103 ? 'wellness' : 'linked_gym' });
  assert.equal(await loadChallengeAudienceCached(103), 'wellness');
  assert.equal(await loadChallengeAudienceCached(104), 'linked_gym');
  assert.equal(fetchCalls, 2);
  profileFor = (id) => ({ id, persona: 'own_gym' });
});

test('a failed lookup is a 503 and is not cached', async () => {
  fetchCalls = 0; fetchFails = true;
  await assert.rejects(loadChallengeAudienceCached(105), (e) => e.status === 503);
  fetchFails = false;
  assert.equal(await loadChallengeAudienceCached(105), 'own_gym', 'next call retries and succeeds');
  assert.equal(fetchCalls, 2);
});

test('the enroll path (uncached) always reads fresh', async () => {
  fetchCalls = 0; fetchFails = false;
  profileFor = (id) => ({ id, persona: 'wellness' });
  assert.equal(await loadChallengeAudience(106), 'wellness');
  profileFor = (id) => ({ id, persona: 'linked_gym' }); // persona switched
  assert.equal(await loadChallengeAudience(106), 'linked_gym', 'no stale audience when deciding what a user may join');
  assert.equal(fetchCalls, 2);
  profileFor = (id) => ({ id, persona: 'own_gym' });
});
