import { test } from 'node:test';
import assert from 'node:assert/strict';

test('queue events never fall back to console or PostHog providers', async (t) => {
  const oldProvider = process.env.ANALYTICS_PROVIDER;
  const oldKey = process.env.POSTHOG_API_KEY;
  const logs = [];
  const fetches = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', (...args) => { fetches.push(args); return Promise.resolve({ ok: true }); });
  try {
    process.env.POSTHOG_API_KEY = 'test-key';
    for (const provider of ['none', 'console', 'posthog']) {
      process.env.ANALYTICS_PROVIDER = provider;
      const { ingest } = await import(`../utils/analytics.js?queue-provider=${provider}`);
      ingest({ event: 'explore_pickup_queue_issue', distinctId: 'A', properties: { sensitive: 'not logged' } });
      ingest({ event: 'explore_pickup_queue_resolved', distinctId: 'A', properties: {} });
    }
    assert.deepEqual(logs, []);
    assert.deepEqual(fetches, []);
    process.env.ANALYTICS_PROVIDER = 'console';
    const { ingest } = await import('../utils/analytics.js?ordinary-provider=console');
    ingest({ event: 'screen_viewed', distinctId: 'A', properties: {} });
    assert.equal(logs.length, 1);
  } finally {
    if (oldProvider === undefined) delete process.env.ANALYTICS_PROVIDER;
    else process.env.ANALYTICS_PROVIDER = oldProvider;
    if (oldKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = oldKey;
  }
});
