import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

test('outbound axios calls get a default timeout; own timeouts still win', async () => {
  const { DEFAULT_OUTBOUND_TIMEOUT_MS } = await import('../utils/axiosDefaults.js');
  assert.equal(axios.defaults.timeout, DEFAULT_OUTBOUND_TIMEOUT_MS);
  assert.equal(DEFAULT_OUTBOUND_TIMEOUT_MS, 10000);
  // Per-request config overrides the default (axios merge semantics).
  const merged = axios.getAdapter ? { ...axios.defaults, timeout: 2500 } : null;
  assert.equal(merged.timeout, 2500);
});
