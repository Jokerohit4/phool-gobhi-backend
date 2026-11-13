// Covers the HMAC-signed booking check-in QR token (utils/qrToken.js) — the
// full verify path: round-trip, wrong booking/gym, tampered payload, expiry,
// and malformed/empty input. The signing secret is pinned BEFORE the module
// import so QR_SECRET picks it up at load time. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-signing-secret';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const NOW_UTC = Date.UTC(2026, 8, 14, 10, 0, 0);

let signQrToken, verifyQrToken;

test('setup: import qrToken once (secret pinned above)', async (t) => {
  ({ signQrToken, verifyQrToken } = await import('../utils/qrToken.js'));
  assert.equal(typeof signQrToken, 'function');
});

test('sign -> verify round-trip for the same booking/gym is valid', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const token = signQrToken(1234, 5);
  assert.deepEqual(verifyQrToken(token, 1234, 5), { valid: true });
});

test("a token validly signed for a different booking is a 'mismatch'", (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const token = signQrToken(9999, 5);
  assert.equal(verifyQrToken(token, 1234, 5).reason, 'mismatch');
});

test("a token validly signed for a different gym is a 'mismatch'", (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const token = signQrToken(1234, 7);
  assert.equal(verifyQrToken(token, 1234, 5).reason, 'mismatch');
});

test('tampering with the payload breaks the signature', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const token = signQrToken(1234, 5);
  const [b, g, e, sig] = token.split('.');
  const forged = [b, g, e, sig.replace(/./, (m) => (m === 'a' ? 'b' : 'a'))].join('.');
  assert.equal(verifyQrToken(forged, 1234, 5).reason, 'bad_signature');
});

test('expired token is rejected as expired', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const expired = signQrToken(1234, 5, -1000); // ttl in the past
  assert.equal(verifyQrToken(expired, 1234, 5).reason, 'expired');
});

test('malformed tokens are rejected as malformed', () => {
  assert.equal(verifyQrToken('not-a-token', 1234, 5).reason, 'malformed');
  assert.equal(verifyQrToken('a.b.c', 1234, 5).reason, 'malformed');
});

test('empty / non-string tokens are rejected as missing', () => {
  assert.equal(verifyQrToken('', 1234, 5).reason, 'missing');
  assert.equal(verifyQrToken(null, 1234, 5).reason, 'missing');
  assert.equal(verifyQrToken(undefined, 1234, 5).reason, 'missing');
});