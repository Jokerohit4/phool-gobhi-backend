// Body-numbers consent: the grant for storing weight, body fat and the other
// numbers a person types in by hand. Run with:
//   node --experimental-test-module-mocks --test
//
// Pins the properties that are easy to lose later:
//   - it is independent of the device-access HealthConsent (typing a weight
//     must never require connecting Apple Health),
//   - the version is server-stamped, so bumping it re-asks everyone,
//   - withdrawing stops new entries and deletes nothing,
//   - the write gate fails closed and never touches reads,
//   - a device-tagged row cannot use POST /biometrics as a side door around the
//     device-consent gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let bioRow = null;
let deviceRow = null;
let lookupThrows = false;
let svc;
let gate;

test('setup: stub Prisma, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.biometricConsent = {
            findUnique: async () => {
              if (lookupThrows) throw new Error('db down');
              return bioRow;
            },
            upsert: async ({ create, update }) => {
              bioRow = bioRow ? { ...bioRow, ...update } : { ...create };
              return bioRow;
            },
            update: async ({ data }) => {
              bioRow = { ...bioRow, ...data };
              return bioRow;
            },
          };
          this.healthConsent = { findUnique: async () => deviceRow };
        }
      },
    },
  });
  svc = await import('../services/biometricConsentService.js');
  gate = await import('../middleware/requireBiometricConsent.js');
});

function reset() {
  bioRow = null;
  deviceRow = null;
  lookupThrows = false;
}

function call(mw, body) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  let nextCalled = false;
  return mw({ userId: 1, body }, res, () => { nextCalled = true; }).then(() => ({ res, nextCalled }));
}

const grantedDevice = () => ({ userId: 1, grantedAt: new Date(), revokedAt: null, policyVersion: 'v1', platform: 'android' });

// --- service -----------------------------------------------------------------

test('never granted: not granted, and not a re-consent prompt either', async () => {
  reset();
  const s = await svc.getBiometricConsentService(1);
  assert.equal(s.granted, false);
  assert.equal(s.needsReconsent, false);
  assert.equal(s.scope, 'body_numbers');
});

test('granting needs no device consent and stamps the SERVER version', async () => {
  reset(); // deviceRow stays null: no Apple Health / Health Connect grant at all
  const s = await svc.grantBiometricConsentService(1);
  assert.equal(s.granted, true);
  assert.equal(bioRow.policyVersion, svc.BIOMETRIC_POLICY_VERSION);
});

test('a grant under older wording is stale, not granted', async () => {
  reset();
  bioRow = { userId: 1, grantedAt: new Date(), revokedAt: null, policyVersion: 'body-numbers-older' };
  const s = await svc.getBiometricConsentService(1);
  assert.equal(s.granted, false);
  assert.equal(s.needsReconsent, true);
});

test('revoking is soft and idempotent', async () => {
  reset();
  await svc.grantBiometricConsentService(1);
  const s = await svc.revokeBiometricConsentService(1);
  assert.equal(s.granted, false);
  assert.ok(bioRow.revokedAt, 'the row survives with revokedAt set');
  const firstRevokedAt = bioRow.revokedAt;
  await svc.revokeBiometricConsentService(1);
  assert.equal(bioRow.revokedAt, firstRevokedAt, 'a second revoke does not rewrite the date');
  reset();
  const none = await svc.revokeBiometricConsentService(1);
  assert.equal(none.granted, false, 'revoking something never granted is not an error');
});

test('re-granting after a revoke clears revokedAt', async () => {
  reset();
  await svc.grantBiometricConsentService(1);
  await svc.revokeBiometricConsentService(1);
  const s = await svc.grantBiometricConsentService(1);
  assert.equal(s.granted, true);
  assert.equal(bioRow.revokedAt, null);
});

// --- POST /biometrics gate -----------------------------------------------------

test('manual entry without consent: refused with BIOMETRIC_CONSENT_REQUIRED', async () => {
  reset();
  const { res, nextCalled } = await call(gate.requireBiometricWriteConsent, {
    entries: [{ metric: 'weight', value: 72 }],
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BIOMETRIC_CONSENT_REQUIRED');
});

test('manual entry with consent passes, even with no device consent', async () => {
  reset();
  await svc.grantBiometricConsentService(1);
  const { nextCalled } = await call(gate.requireBiometricWriteConsent, { metric: 'weight', value: 72 });
  assert.equal(nextCalled, true);
});

test('device consent alone does NOT unlock manual entry', async () => {
  reset();
  deviceRow = grantedDevice();
  const { res, nextCalled } = await call(gate.requireBiometricWriteConsent, {
    entries: [{ metric: 'weight', value: 72, source: 'manual' }],
  });
  assert.equal(nextCalled, false);
  assert.equal(res.body.code, 'BIOMETRIC_CONSENT_REQUIRED');
});

test('stale grant: refused with the review code, not the opt-in one', async () => {
  reset();
  bioRow = { userId: 1, grantedAt: new Date(), revokedAt: null, policyVersion: 'body-numbers-older' };
  const { res } = await call(gate.requireBiometricWriteConsent, { metric: 'weight', value: 72 });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BIOMETRIC_CONSENT_OUTDATED');
  assert.equal(res.body.currentVersion, svc.BIOMETRIC_POLICY_VERSION);
});

test('a device-tagged row needs device consent, not body-numbers consent', async () => {
  reset();
  await svc.grantBiometricConsentService(1); // body-numbers yes, device no
  const refused = await call(gate.requireBiometricWriteConsent, {
    entries: [{ metric: 'resting_hr', value: 55, source: 'healthkit' }],
  });
  assert.equal(refused.nextCalled, false);
  assert.equal(refused.res.body.code, 'HEALTH_CONSENT_REQUIRED');

  reset();
  deviceRow = grantedDevice(); // device yes, body-numbers no
  const allowed = await call(gate.requireBiometricWriteConsent, {
    entries: [{ metric: 'resting_hr', value: 55, source: 'health_connect' }],
  });
  assert.equal(allowed.nextCalled, true);
});

test('a mixed batch needs both consents', async () => {
  reset();
  deviceRow = grantedDevice();
  const body = {
    entries: [
      { metric: 'weight', value: 72 },
      { metric: 'resting_hr', value: 55, source: 'healthkit' },
    ],
  };
  assert.equal((await call(gate.requireBiometricWriteConsent, body)).nextCalled, false);
  await svc.grantBiometricConsentService(1);
  assert.equal((await call(gate.requireBiometricWriteConsent, body)).nextCalled, true);
});

test('an empty body is left to the controller to reject', async () => {
  reset();
  const { nextCalled } = await call(gate.requireBiometricWriteConsent, {});
  assert.equal(nextCalled, true);
});

test('lookup failure fails closed', async () => {
  reset();
  lookupThrows = true;
  const { res, nextCalled } = await call(gate.requireBiometricWriteConsent, { metric: 'weight', value: 72 });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'BIOMETRIC_CONSENT_CHECK_FAILED');
});

// --- PUT /ledger/setup weight gate ---------------------------------------------

test('intake with a weight needs body-numbers consent; without one it passes', async () => {
  reset();
  const withWeight = await call(gate.requireBiometricConsentForIntakeWeight, { goal: 'recomp', weightKg: 72.5 });
  assert.equal(withWeight.nextCalled, false);
  assert.equal(withWeight.res.body.code, 'BIOMETRIC_CONSENT_REQUIRED');

  const noWeight = await call(gate.requireBiometricConsentForIntakeWeight, { goal: 'recomp', age: 29 });
  assert.equal(noWeight.nextCalled, true);

  await svc.grantBiometricConsentService(1);
  const granted = await call(gate.requireBiometricConsentForIntakeWeight, { weightKg: 72.5 });
  assert.equal(granted.nextCalled, true);
});

// --- wiring, checked textually (no server needed) ---------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');

test('only the write is gated: reads, exports and deletes are not', () => {
  const routes = read('routes', 'health.js');
  assert.match(routes, /router\.post\('\/biometrics', [^\n]*requireBiometricWriteConsent/);
  for (const line of routes.split('\n').filter((l) => /router\.(get|delete)\('\/biometrics/.test(l))) {
    assert.doesNotMatch(line, /requireBiometricWriteConsent/, `read/delete route is consent-gated: ${line}`);
  }
  // Granting is adults-only; withdrawing is not flag-gated.
  assert.match(routes, /router\.post\('\/biometrics\/consent', [^\n]*requireAdult/);
  assert.match(routes, /router\.delete\('\/biometrics\/consent', requireAuth,/);
  // Consent routes must be registered before the gated POST so opting in is
  // always reachable.
  assert.ok(routes.indexOf("'/biometrics/consent'") < routes.indexOf("router.post('/biometrics', "));
  assert.match(read('routes', 'ledger.js'), /'\/ledger\/setup', [^\n]*requireBiometricConsentForIntakeWeight/);
});

test('the consent record is both exported and erased', () => {
  assert.match(read('services', 'exportService.js'), /prisma\.biometricConsent\.findUnique/);
  assert.match(read('services', 'consentService.js'), /prisma\.biometricConsent\.deleteMany/);
});

test('the migration creates every BiometricConsent column the schema declares', () => {
  const schema = read('prisma', 'schema.prisma');
  const body = schema.match(/model BiometricConsent \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'model BiometricConsent is missing from the schema');
  const fields = [...body.matchAll(/^\s{2}(\w+)\s+(String|Int|DateTime)/gm)].map((m) => m[1]);
  const migrations = readdirSync(join(here, '..', 'prisma', 'migrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => read('prisma', 'migrations', e.name, 'migration.sql'))
    .join('\n')
    .replace(/--[^\n]*/g, '');
  const table = migrations.match(/CREATE TABLE (?:IF NOT EXISTS )?"health"\."BiometricConsent"[^;]*;/s)?.[0];
  assert.ok(table, 'no migration creates health.BiometricConsent');
  for (const f of fields) assert.match(table, new RegExp(`"${f}"`), `migration is missing BiometricConsent."${f}"`);
});
