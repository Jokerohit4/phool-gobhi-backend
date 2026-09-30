// The server-side gate on device sync (POST /daily-activity/sync). Pins the
// property that matters: once a user revokes health consent in the app, the
// server stops accepting HealthKit/Health Connect numbers even if the OS
// permission is still granted and the app keeps trying. Also pins fail-closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let healthConsent = null;
let lookupThrows = false;
let requireDeviceHealthConsent;

test('setup: stub Prisma, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.healthConsent = {
            findUnique: async () => {
              if (lookupThrows) throw new Error('db down');
              return healthConsent;
            },
          };
        }
      },
    },
  });
  ({ requireDeviceHealthConsent } = await import('../middleware/requireDeviceHealthConsent.js'));
});

function run() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  return requireDeviceHealthConsent({ userId: 1 }, res, () => { nextCalled = true; })
    .then(() => ({ res, nextCalled }));
}

test('no consent record: refused with a code the app can act on', async () => {
  healthConsent = null;
  lookupThrows = false;
  const { res, nextCalled } = await run();
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'HEALTH_CONSENT_REQUIRED');
});

test('granted consent: passes through', async () => {
  healthConsent = { userId: 1, grantedAt: new Date(), revokedAt: null, policyVersion: 'v1', platform: 'android' };
  lookupThrows = false;
  const { nextCalled } = await run();
  assert.equal(nextCalled, true);
});

test('revoked consent: refused even though a record exists', async () => {
  healthConsent = { userId: 1, grantedAt: new Date('2026-09-01'), revokedAt: new Date('2026-09-02'), policyVersion: 'v1', platform: 'ios' };
  lookupThrows = false;
  const { res, nextCalled } = await run();
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('lookup failure fails closed', async () => {
  lookupThrows = true;
  const { res, nextCalled } = await run();
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'HEALTH_CONSENT_CHECK_FAILED');
});
