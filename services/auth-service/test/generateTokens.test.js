// Covers JWT signing in utils/generateTokens.js: the access token (15m HS256
// with {id,role,type}) and the refresh token (expiry driven by the rotation
// family's fixed absolute expiresAt, never extended per rotation). Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const NOW_UTC = Date.UTC(2026, 8, 14, 10, 0, 0);

let generateAccessToken, signRefreshToken;

test('setup: import generateTokens', async () => {
  ({ generateAccessToken, signRefreshToken } = await import('../utils/generateTokens.js'));
  assert.equal(typeof generateAccessToken, 'function');
  assert.equal(typeof signRefreshToken, 'function');
});

test('generateAccessToken: signs HS256 with {id, role, type} and 15m expiry', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const token = generateAccessToken(42, 'customer', 'premium');
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(payload.id, 42);
  assert.equal(payload.role, 'customer');
  assert.equal(payload.type, 'premium');
  assert.equal(payload.exp - payload.iat, 15 * 60);
});

test('generateAccessToken: null role/type are preserved (clients fill the gaps downstream)', () => {
  const token = generateAccessToken(7, null, undefined);
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(payload.role, null);
  assert.equal(payload.type, undefined);
});

test('signRefreshToken: expiresIn matches the family’s fixed absolute expiry', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const expiresAt = new Date(NOW_UTC + 7 * 24 * 60 * 60 * 1000);
  const token = signRefreshToken(3, 'jti-1', 'family-1', expiresAt);
  const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  assert.equal(payload.id, 3);
  assert.equal(payload.jti, 'jti-1');
  assert.equal(payload.familyId, 'family-1');
  assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);
});

test('signRefreshToken: survives rotation without extending total session length', (t) => {
  // A rotation that lands 6 days in must produce a token valid only 1 more day
  // — total session length stays 7 days no matter how many times it rotates.
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC + 6 * 24 * 60 * 60 * 1000 });
  const expiresAt = new Date(NOW_UTC + 7 * 24 * 60 * 60 * 1000);
  const token = signRefreshToken(3, 'jti-2', 'family-1', expiresAt);
  const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  assert.equal(payload.exp - payload.iat, 24 * 60 * 60);
});

test('signRefreshToken: never emits a zero/negative expiry (clamps to 1s)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const alreadyPast = new Date(NOW_UTC - 5 * 1000);
  const token = signRefreshToken(3, 'jti-3', 'family-2', alreadyPast);
  const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  assert.equal(payload.exp - payload.iat, 1);
});