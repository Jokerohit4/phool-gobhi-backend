// Health+ consent grants are adults-only (DPDP s.9(3): no behavioural
// monitoring of children). Pins the birthday boundary, the missing-DOB path
// (a distinct code, so the app can ask for the field instead of refusing),
// and fail-closed when auth-service can't be reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let profile = null;
let mod;

test('setup: stub the auth-service lookup, import once', async (t) => {
  t.mock.module('../utils/fetchUserProfile.js', {
    exports: { fetchUserProfileInternal: async () => profile },
  });
  mod = await import('../middleware/requireAdult.js');
});

async function run() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  await mod.requireAdult({ userId: 1 }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('ageInYears: the day before the 18th birthday is still 17', () => {
  assert.equal(mod.ageInYears('2008-10-01', new Date('2026-09-30T12:00:00Z')), 17);
  assert.equal(mod.ageInYears('2008-10-01', new Date('2026-10-01T00:00:00Z')), 18);
});

test('ageInYears: garbage DOB is null, never a number', () => {
  assert.equal(mod.ageInYears('not-a-date'), null);
});

test('adult passes', async () => {
  profile = { id: 1, dateOfBirth: '1995-01-01' };
  const { nextCalled } = await run();
  assert.equal(nextCalled, true);
});

test('under 18 is refused with UNDER_MIN_AGE', async () => {
  const d = new Date();
  profile = { id: 1, dateOfBirth: `${d.getUTCFullYear() - 16}-01-01` };
  const { res, nextCalled } = await run();
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'UNDER_MIN_AGE');
});

test('missing DOB asks for it rather than refusing outright', async () => {
  profile = { id: 1, dateOfBirth: null };
  const { res, nextCalled } = await run();
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'DOB_REQUIRED');
});

test('auth-service unreachable fails closed', async () => {
  profile = null;
  const { res, nextCalled } = await run();
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'AGE_CHECK_FAILED');
});
