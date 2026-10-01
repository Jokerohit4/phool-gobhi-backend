// A burst of concurrent flag checks against a cold cache must make ONE
// /app-config call, not one per request. Seen in auth-service-dev logs on
// 2026-10-01: a single app launch produced ~17 identical fetches in <100ms
// because each concurrent request missed the empty cache independently.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('concurrent flag checks share one in-flight /app-config fetch', async (t) => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    await gate; // hold the response so every caller arrives while it's in flight
    return { ok: true, json: async () => ({ features: { demoFlag: { enabled: true } } }) };
  });

  const { isFeatureEnabled } = await import('../middleware/requireFeatureFlag.js');
  const pending = Array.from({ length: 20 }, () => isFeatureEnabled('demoFlag'));
  release();
  const results = await Promise.all(pending);

  assert.equal(calls, 1);
  assert.ok(results.every(Boolean));

  // Within the TTL the cache answers without another fetch.
  assert.equal(await isFeatureEnabled('demoFlag'), true);
  assert.equal(calls, 1);
});
