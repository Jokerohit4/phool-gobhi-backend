// The `location_routes` consent scope that recorded GPS run routes live behind
// (run-tracker-spec.html §12). The spec requires the client to request
// ['health_data', 'location_routes'] on first run; before this existed the
// server only knew about cycle_tracking, so a compliant client would have been
// rejected. These tests pin the scope's behaviour, especially the separation
// from cycle_tracking — revoking one must not touch the other — and the
// fail-closed property that a route can never be read or written without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let healthConsent = null;
let svc;
let middleware;

function resetFakes() {
  healthConsent = {
    userId: 1,
    grantedAt: new Date('2026-09-01'),
    revokedAt: null,
    policyVersion: 'health-2026-09-01',
    scopes: ['logs'],
  };
}

test('setup: stub Prisma, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.healthConsent = {
            findUnique: async () => healthConsent,
            update: async ({ data }) => {
              healthConsent = { ...healthConsent, ...data };
              return healthConsent;
            },
          };
          this.$transaction = async (ops) => {
            for (const op of ops) await op;
            return [];
          };
        }
      },
    },
  });
  svc = await import('../services/locationRoutesService.js');
  middleware = await import('../middleware/requireLocationRoutesConsent.js');
});

test('the scope is named location_routes', () => {
  assert.equal(svc.LOCATION_ROUTES_SCOPE, 'location_routes');
});

test('no consent record means not granted', async () => {
  healthConsent = null;
  assert.equal(await svc.hasLocationRoutesConsentService(1), false);
});

test('a record without the scope means not granted', async () => {
  resetFakes();
  assert.equal(await svc.hasLocationRoutesConsentService(1), false);
});

test('granting adds the scope without dropping existing ones', async () => {
  resetFakes();
  const out = await svc.grantLocationRoutesConsentService(1, {
    privacyVersion: 'routes-2026-09-24',
  });
  assert.equal(out.granted, true);
  assert.equal(out.privacyVersion, 'routes-2026-09-24');
  assert.ok(healthConsent.scopes.includes('logs'), 'keeps the logs scope');
  assert.ok(healthConsent.scopes.includes('location_routes'));
  assert.equal(await svc.hasLocationRoutesConsentService(1), true);
});

test('granting twice is idempotent', async () => {
  resetFakes();
  await svc.grantLocationRoutesConsentService(1);
  await svc.grantLocationRoutesConsentService(1);
  const occurrences = healthConsent.scopes.filter(
    (s) => s === 'location_routes',
  ).length;
  assert.equal(occurrences, 1);
});

test('granting without live health consent is refused (409)', async () => {
  healthConsent = null;
  await assert.rejects(
    () => svc.grantLocationRoutesConsentService(1),
    (err) => err.status === 409 && err.code === 'HEALTH_CONSENT_REQUIRED',
  );
});

test('a revoked health consent cannot hold a live route grant', async () => {
  resetFakes();
  await svc.grantLocationRoutesConsentService(1);
  healthConsent = { ...healthConsent, revokedAt: new Date() };
  // Revoking health consent withdraws the route scope with it: one withdrawal,
  // not two the user has to find separately.
  assert.equal(await svc.hasLocationRoutesConsentService(1), false);
});

test('withdrawing the scope leaves recorded data alone', async () => {
  resetFakes();
  await svc.grantLocationRoutesConsentService(1);
  const out = await svc.revokeLocationRoutesConsentService(1);
  assert.equal(out.granted, false);
  assert.ok(!healthConsent.scopes.includes('location_routes'));
  // Erasure is a separate explicit act; a toggle must not destroy run history.
  assert.equal(await svc.hasLocationRoutesConsentService(1), false);
});

test('withdrawing routes does not disturb an existing cycle grant', async () => {
  resetFakes();
  healthConsent.scopes = ['logs', 'cycle_tracking'];
  await svc.grantLocationRoutesConsentService(1);
  await svc.revokeLocationRoutesConsentService(1);
  assert.ok(
    healthConsent.scopes.includes('cycle_tracking'),
    'cycle_tracking must survive a routes withdrawal',
  );
  assert.ok(!healthConsent.scopes.includes('location_routes'));
});

test('status reports granted and the privacy version', async () => {
  resetFakes();
  const before = await svc.getLocationRoutesConsentService(1);
  assert.equal(before.granted, false);
  await svc.grantLocationRoutesConsentService(1, { privacyVersion: 'v2' });
  const after = await svc.getLocationRoutesConsentService(1, 'v2');
  assert.equal(after.granted, true);
  assert.equal(after.privacyVersion, 'v2');
});

test('the middleware passes through when granted', async () => {
  resetFakes();
  await svc.grantLocationRoutesConsentService(1);
  let nexted = false;
  const res = { status: () => res, json: () => res };
  await middleware.requireLocationRoutesConsent({ userId: 1 }, res, () => {
    nexted = true;
  });
  assert.equal(nexted, true);
});

test('the middleware 403s with a code the UI can turn into a prompt', async () => {
  resetFakes();
  let payload = null;
  let code = null;
  const res = {
    status(s) { code = s; return res; },
    json(p) { payload = p; return res; },
  };
  await middleware.requireLocationRoutesConsent({ userId: 1 }, res, () => {
    throw new Error('must not call next() without consent');
  });
  assert.equal(code, 403);
  assert.equal(payload.code, 'ROUTE_CONSENT_REQUIRED');
});

test('the middleware fails CLOSED when the lookup throws', async () => {
  resetFakes();
  // A getter that throws stands in for a database failure: the consent row
  // cannot be read, so the check must not fall open.
  healthConsent = {
    get scopes() { throw new Error('db down'); },
  };
  let code = null;
  const res = {
    status(s) { code = s; return res; },
    json: () => res,
  };
  await middleware.requireLocationRoutesConsent({ userId: 1 }, res, () => {
    throw new Error('must not call next() when the check cannot be completed');
  });
  assert.equal(code, 503);
});
