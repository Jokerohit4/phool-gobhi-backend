// getUsersBatchInternal: 60s per-user-id display cache, single-flight, failures not cached.
// Run with: node --experimental-test-module-mocks --test test/authClientNameCache.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });

let n = 0;
async function load() {
  n++;
  return import(`../services/authClient.js?names=${n}`);
}
function stubFetch(t, { fail = () => false } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_u, opts) => {
    const { ids } = JSON.parse(opts.body);
    calls.push(ids);
    await new Promise((r) => setTimeout(r, 5));
    if (fail()) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ data: ids.map((id) => ({ id, name: `N${id}` })) }) };
  });
  return calls;
}

test('off by default under node --test: every call fetches', async (t) => {
  const calls = stubFetch(t);
  const { getUsersBatchInternal } = await load();
  await getUsersBatchInternal([1, 2]);
  await getUsersBatchInternal([1, 2]);
  assert.equal(calls.length, 2);
});

test('forced on: per-id hits, only misses are fetched, ONE call for the misses', async (t) => {
  process.env.BUDDY_CACHE_FORCE = '1';
  try {
    const calls = stubFetch(t);
    const { getUsersBatchInternal } = await load();
    assert.deepEqual((await getUsersBatchInternal([1, 2])).map((u) => u.name), ['N1', 'N2']);
    const out = await getUsersBatchInternal([2, 3, 4]);
    assert.deepEqual(out.map((u) => u.id), [2, 3, 4]);
    assert.deepEqual(calls, [[1, 2], [3, 4]]);
    await getUsersBatchInternal([1, 4]);
    assert.equal(calls.length, 2, 'fully cached');
  } finally { delete process.env.BUDDY_CACHE_FORCE; }
});

test('forced on: concurrent callers share one in-flight fetch', async (t) => {
  process.env.BUDDY_CACHE_FORCE = '1';
  try {
    const calls = stubFetch(t);
    const { getUsersBatchInternal } = await load();
    await Promise.all([getUsersBatchInternal([1, 2]), getUsersBatchInternal([1, 2])]);
    assert.equal(calls.length, 1);
  } finally { delete process.env.BUDDY_CACHE_FORCE; }
});

test('forced on: a failure rejects and is not cached; empty input skips the call', async (t) => {
  process.env.BUDDY_CACHE_FORCE = '1';
  try {
    let down = true;
    const calls = stubFetch(t, { fail: () => down });
    const { getUsersBatchInternal } = await load();
    assert.deepEqual(await getUsersBatchInternal([]), []);
    await assert.rejects(getUsersBatchInternal([1]), (e) => e.status === 502);
    down = false;
    assert.equal((await getUsersBatchInternal([1]))[0].name, 'N1');
    assert.equal(calls.length, 2);
  } finally { delete process.env.BUDDY_CACHE_FORCE; }
});

test('forced on: entries expire after 60s', async (t) => {
  process.env.BUDDY_CACHE_FORCE = '1';
  try {
    let now = 9_000_000;
    t.mock.method(Date, 'now', () => now);
    const calls = stubFetch(t);
    const { getUsersBatchInternal } = await load();
    await getUsersBatchInternal([1]);
    now += 59_000;
    await getUsersBatchInternal([1]);
    assert.equal(calls.length, 1);
    now += 2_000;
    await getUsersBatchInternal([1]);
    assert.equal(calls.length, 2);
  } finally { delete process.env.BUDDY_CACHE_FORCE; }
});
