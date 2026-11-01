// requireFeatureFlag outage behaviour:
//  - the /app-config fetch carries an abort signal (it used to have no timeout,
//    so the first request on an instance could hang on a stuck auth-service);
//  - a failed refresh does NOT make every later request refetch: last-known flags
//    (or fail-closed {} on a cold start) are served and the retry is spaced ~5s;
//  - recovery is picked up on the first retry after the window.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fresh(t) {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  const mod = await import(`../middleware/requireFeatureFlag.js?outage=${Math.random()}`);
  return { mod, advance: (ms) => { now += ms; } };
}

test('the flag fetch is given a timeout signal', async (t) => {
  let seenSignal;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    seenSignal = opts?.signal;
    return { ok: true, json: async () => ({ features: { f: { enabled: true } } }) };
  });
  const { mod } = await fresh(t);
  assert.equal(await mod.isFeatureEnabled('f'), true);
  assert.ok(seenSignal instanceof AbortSignal);
});

test('cold-start outage fails closed, then retries at most every 5s and recovers', async (t) => {
  let calls = 0;
  let up = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (!up) throw new Error('timeout');
    return { ok: true, json: async () => ({ features: { f: { enabled: true } } }) };
  });
  const { mod, advance } = await fresh(t);
  assert.equal(await mod.isFeatureEnabled('f'), false); // fail closed
  for (let i = 0; i < 10; i++) assert.equal(await mod.isFeatureEnabled('f'), false);
  assert.equal(calls, 1, 'no hammering inside the retry window');
  up = true;
  advance(5_001);
  assert.equal(await mod.isFeatureEnabled('f'), true);
  assert.equal(calls, 2);
});

test('after the TTL, an outage keeps serving last-known flags and spaces retries', async (t) => {
  let calls = 0;
  let up = true;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (!up) throw new Error('503');
    return { ok: true, json: async () => ({ features: { f: { enabled: true } } }) };
  });
  const { mod, advance } = await fresh(t);
  assert.equal(await mod.isFeatureEnabled('f'), true);
  up = false;
  advance(31_000); // TTL expired
  assert.equal(await mod.isFeatureEnabled('f'), true); // fail open to last-known
  assert.equal(calls, 2);
  for (let i = 0; i < 10; i++) assert.equal(await mod.isFeatureEnabled('f'), true);
  assert.equal(calls, 2, 'no refetch inside the 5s window');
  advance(5_001);
  await mod.isFeatureEnabled('f');
  assert.equal(calls, 3);
  up = true;
  advance(5_001);
  assert.equal(await mod.isFeatureEnabled('f'), true);
  assert.equal(calls, 4);
  // healthy again: cached for the full TTL
  await mod.isFeatureEnabled('f');
  assert.equal(calls, 4);
});

test('warm-at-load: warms once on Cloud Run, skipped under tests, never throws', async (t) => {
  let calls = 0;
  let up = true;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (!up) throw new Error('down');
    return { ok: true, json: async () => ({ features: { f: { enabled: true } } }) };
  });
  const { mod } = await fresh(t);
  assert.equal(calls, 0, 'importing under node --test must not fetch');
  assert.equal(mod.warmFeatureFlags(), null, 'skipped under node --test');
  assert.equal(mod.warmFeatureFlags({ env: { K_SERVICE: 'svc' , NODE_TEST_CONTEXT: '1' } }), null);
  assert.equal(mod.warmFeatureFlags({ env: {} }), null, 'skipped off Cloud Run');
  await mod.warmFeatureFlags({ env: { K_SERVICE: 'svc' } });
  assert.equal(calls, 1);
  assert.equal(await mod.isFeatureEnabled('f'), true);
  assert.equal(calls, 1, 'first request after warm-up is served from cache');
});

test('warm-at-load: an auth-service outage during warm-up resolves quietly and stays fail-closed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('down'); });
  const { mod } = await fresh(t);
  await assert.doesNotReject(mod.warmFeatureFlags({ env: { K_SERVICE: 'svc' } }));
  assert.equal(await mod.isFeatureEnabled('f'), false);
});
