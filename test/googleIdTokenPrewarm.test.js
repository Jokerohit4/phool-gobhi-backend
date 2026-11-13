import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prewarmIdTokens } from '../utils/googleIdToken.js';

test('prewarm is skipped under node --test even when enabled', async () => {
  const calls = [];
  await prewarmIdTokens(['https://a'], { enabled: true, fetchToken: async (a) => calls.push(a) });
  assert.deepEqual(calls, []);
});

test('prewarm fetches once per configured URL, never throws', async () => {
  const saved = [process.env.NODE_ENV, process.env.NODE_TEST_CONTEXT];
  process.env.NODE_ENV = 'production'; delete process.env.NODE_TEST_CONTEXT;
  try {
    const calls = [];
    const urls = ['https://a', 'https://b', 'https://a', '', undefined, 'https://c'];
    await prewarmIdTokens(urls, { enabled: true, fetchToken: async (a) => { calls.push(a); if (a === 'https://b') throw new Error('metadata down'); } });
    assert.deepEqual(calls.sort(), ['https://a', 'https://b', 'https://c']);
    await assert.doesNotReject(prewarmIdTokens(['https://x'], { enabled: true, fetchToken: () => { throw new Error('sync boom'); } }));
    const off = [];
    await prewarmIdTokens(['https://a'], { enabled: false, fetchToken: async (a) => off.push(a) });
    assert.deepEqual(off, []);
  } finally {
    process.env.NODE_ENV = saved[0] ?? 'test';
    if (saved[1] !== undefined) process.env.NODE_TEST_CONTEXT = saved[1];
  }
});
