// Covers the shared API response envelope (utils/response.js) that every
// auth-service route wraps. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let baseResponse, successResponse, errorResponse;

test('setup: import response builders', async () => {
  ({ baseResponse, successResponse, errorResponse } = await import('../utils/response.js'));
  assert.equal(typeof baseResponse, 'function');
});

test('baseResponse: returns the canonical envelope with the exact key set', () => {
  const out = baseResponse({ status: 'success', data: { a: 1 } });
  assert.equal(out.status, 'success');
  assert.equal(out.errorCode, null);
  assert.equal(out.errorMessage, null);
  assert.deepEqual(out.data, { a: 1 });
  assert.equal(typeof out.timestamp, 'string');
  assert.ok(!Number.isNaN(Date.parse(out.timestamp)));
  assert.equal(out.meta, undefined); // omitted when not passed
});

test('baseResponse: includes meta only when provided', () => {
  const withMeta = baseResponse({ status: 'error', errorCode: 'E1', errorMessage: 'nope', data: null, meta: { page: 2 } });
  assert.deepEqual(withMeta.meta, { page: 2 });
  const withoutMeta = baseResponse({ status: 'error' });
  assert.equal(withoutMeta.meta, undefined);
});

test('successResponse: status success, carries data, no error fields set', () => {
  const out = successResponse({ balance: 10 }, { nextCursor: 'x' });
  assert.equal(out.status, 'success');
  assert.deepEqual(out.data, { balance: 10 });
  assert.equal(out.errorCode, null);
  assert.deepEqual(out.meta, { nextCursor: 'x' });
});

test('successResponse: null data is fine (empty list/optional payloads)', () => {
  const out = successResponse(null);
  assert.equal(out.status, 'success');
  assert.equal(out.data, null);
  assert.equal(out.errorCode, null);
});

test('errorResponse: status error with the aimed error code/message', () => {
  const out = errorResponse('E109', 'Invalid or expired refresh token');
  assert.equal(out.status, 'error');
  assert.equal(out.errorCode, 'E109');
  assert.equal(out.errorMessage, 'Invalid or expired refresh token');
  assert.equal(out.data, null);
  assert.equal(out.meta, undefined);
});