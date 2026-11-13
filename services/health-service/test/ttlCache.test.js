// ttlCache: single-flight loading, TTL, eviction, and the invalidate-vs-in-flight
// race that would otherwise let a stale load repopulate the cache after a write.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../utils/ttlCache.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('disabled under the test runner by default (ttl 0 = loader every call)', async () => {
  const cache = createTtlCache({ ttlMs: 10_000 });
  let calls = 0;
  await cache.get('k', async () => ++calls);
  await cache.get('k', async () => ++calls);
  assert.equal(calls, 2);
});

test('hit within the TTL; reload after it expires', async () => {
  const cache = createTtlCache({ ttlMs: 30, forceEnabled: true });
  let calls = 0;
  assert.equal(await cache.get('k', async () => ++calls), 1);
  assert.equal(await cache.get('k', async () => ++calls), 1, 'served from cache');
  await tick(50);
  assert.equal(await cache.get('k', async () => ++calls), 2, 'expired -> reloaded');
});

test('parallel callers share ONE load (single-flight)', async () => {
  const cache = createTtlCache({ ttlMs: 1000, forceEnabled: true });
  let calls = 0;
  const loader = async () => { calls++; await tick(20); return { n: calls }; };
  const [a, b, c] = await Promise.all([cache.get('k', loader), cache.get('k', loader), cache.get('k', loader)]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, c], [{ n: 1 }, { n: 1 }, { n: 1 }]);
});

test('keys are independent', async () => {
  const cache = createTtlCache({ ttlMs: 1000, forceEnabled: true });
  assert.equal(await cache.get(1, async () => 'a'), 'a');
  assert.equal(await cache.get(2, async () => 'b'), 'b');
  assert.equal(await cache.get(1, async () => 'x'), 'a');
});

test('a failed load is not cached and does not wedge the key', async () => {
  const cache = createTtlCache({ ttlMs: 1000, forceEnabled: true });
  await assert.rejects(cache.get('k', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cache.get('k', async () => 'ok'), 'ok');
});

test('a synchronous throw in the loader does not leak an in-flight record', async () => {
  const cache = createTtlCache({ ttlMs: 1000, forceEnabled: true });
  await assert.rejects(cache.get('k', () => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(await cache.get('k', async () => 'ok'), 'ok');
});

test('cacheable(value) = false serves the value but does not store it', async () => {
  const cache = createTtlCache({ ttlMs: 1000, forceEnabled: true });
  let calls = 0;
  const loader = async () => ({ degraded: true, n: ++calls });
  const opts = { cacheable: (v) => !v.degraded };
  assert.equal((await cache.get('k', loader, opts)).n, 1);
  assert.equal((await cache.get('k', loader, opts)).n, 2, 'degraded result was not cached');
});

test('invalidate drops the entry', async () => {
  const cache = createTtlCache({ ttlMs: 1000, forceEnabled: true });
  let calls = 0;
  await cache.get('k', async () => ++calls);
  cache.invalidate('k');
  assert.equal(await cache.get('k', async () => ++calls), 2);
});

test('invalidate during an in-flight load: the stale result is NOT stored', async () => {
  const cache = createTtlCache({ ttlMs: 1000, forceEnabled: true });
  let release;
  const gate = new Promise((r) => { release = r; });
  const stale = cache.get('k', async () => { await gate; return 'stale'; });
  await tick(); // load is now in flight
  cache.invalidate('k'); // a write happened
  release();
  assert.equal(await stale, 'stale', 'the request that started before the write still gets its own answer');
  assert.equal(await cache.get('k', async () => 'fresh'), 'fresh', 'but it never repopulated the cache');
});

test('maxEntries bounds memory (oldest evicted first)', async () => {
  const cache = createTtlCache({ ttlMs: 1000, maxEntries: 3, forceEnabled: true });
  for (const k of [1, 2, 3, 4]) await cache.get(k, async () => k);
  assert.equal(cache.size, 3);
  let reloaded = false;
  await cache.get(1, async () => { reloaded = true; return 1; });
  assert.equal(reloaded, true, 'key 1 (oldest) was evicted');
});
