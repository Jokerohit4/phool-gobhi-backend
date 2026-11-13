import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRetryableError } from './error-envelope.mjs';

const response = (code, status, retryAfter) => ({ status, retryAfter, body: { error: {
  code, messageKey: `explore.error.${code.toLowerCase()}`, retryable: true,
  requestId: 'bd7e43bf-86f9-49bb-9c68-240e8cd14d56',
} } });
test('exact generic 500 and separate known-outage 503 envelopes remain distinct', () => {
  assertRetryableError(response('INTERNAL_ERROR', 500, null));
  assertRetryableError(response('WORLD_UNAVAILABLE', 503, '5'), 'WORLD_UNAVAILABLE');
  assert.throws(() => assertRetryableError(response('INTERNAL_ERROR', 500, '5')));
  assert.throws(() => assertRetryableError(response('WORLD_UNAVAILABLE', 503, '5')));
});
test('envelope assertion rejects diagnostic leakage, invalid identity and nonretryable outcomes', () => {
  for (const mutate of [
    r => { r.body.error.sql = 'private'; }, r => { r.body.extra = {}; },
    r => { r.body.error.requestId = ''; }, r => { r.body.error.retryable = false; },
  ]) {
    const r = response('INTERNAL_ERROR', 500, null); mutate(r);
    assert.throws(() => assertRetryableError(r));
  }
});
