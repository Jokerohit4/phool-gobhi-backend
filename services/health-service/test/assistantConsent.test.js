// Assistant consent and its versioning. Run with:
//   node --experimental-test-module-mocks --test
//
// The point of interest is re-consent: bumping the server-side policy version
// must make every existing agreement stale. That works only because the
// version is stamped by the server and never accepted from the client — which
// is exactly what HealthConsent.policyVersion does NOT do, so it is worth
// proving rather than assuming.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let consentRow = null;
let getConsentStatusService, grantConsentService, revokeConsentService, CURRENT_POLICY_VERSION;

test('setup: stub Prisma, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.assistantConsent = {
            findUnique: async () => consentRow,
            upsert: async ({ create, update }) => {
              consentRow = consentRow ? { ...consentRow, ...update } : { ...create };
              return consentRow;
            },
            update: async ({ data }) => {
              consentRow = { ...consentRow, ...data };
              return consentRow;
            },
          };
          this.assistantConversation = { findMany: async () => [] };
          this.assistantMessage = { findMany: async () => [], count: async () => 0 };
          this.assistantMemory = { findMany: async () => [] };
          this.assistantRateLimitLog = { count: async () => 0, create: async () => ({}) };
          this.workoutSession = { findMany: async () => [] };
          this.personalisationProfile = { findUnique: async () => null };
          this.weeklyGoal = { findUnique: async () => null };
        }
      },
      Prisma: {},
    },
  });

  ({ getConsentStatusService, grantConsentService, revokeConsentService } = await import(
    '../services/assistant/assistantService.js'
  ));
  ({ CURRENT_POLICY_VERSION } = await import('../services/assistant/assistantPolicy.js'));
});

test('no record means not granted, and not a re-consent prompt either', async () => {
  consentRow = null;
  const status = await getConsentStatusService(1);
  assert.equal(status.granted, false);
  // A first-time user must see a first-run screen, not "the terms changed".
  assert.equal(status.needsReconsent, false);
});

test('granting records the SERVER version, whatever the caller wanted', async () => {
  consentRow = null;
  const status = await grantConsentService(1);
  assert.equal(status.granted, true);
  assert.equal(consentRow.policyVersion, CURRENT_POLICY_VERSION);
});

test('consent under older wording is stale, not granted', async () => {
  // The whole re-consent mechanism in one assertion: bump the constant, and
  // everyone who agreed to the old text is asked again.
  consentRow = {
    userId: 1,
    grantedAt: new Date(),
    revokedAt: null,
    policyVersion: 'assistant-some-older-version',
  };
  const status = await getConsentStatusService(1);
  assert.equal(status.granted, false);
  assert.equal(status.needsReconsent, true);
});

test('revoking is soft — the record that they once agreed survives', async () => {
  consentRow = {
    userId: 1,
    grantedAt: new Date('2026-09-18T00:00:00Z'),
    revokedAt: null,
    policyVersion: CURRENT_POLICY_VERSION,
  };
  const status = await revokeConsentService(1);
  assert.equal(status.granted, false);
  assert.ok(consentRow.revokedAt, 'revokedAt set');
  assert.ok(consentRow.grantedAt, 'grantedAt preserved for audit');
});

test('a revoked user is not treated as needing re-consent', async () => {
  // They did not decline the new terms; they withdrew. Showing them "the
  // terms changed" would misrepresent their own decision back to them.
  consentRow = {
    userId: 1,
    grantedAt: new Date(),
    revokedAt: new Date(),
    policyVersion: 'assistant-some-older-version',
  };
  const status = await getConsentStatusService(1);
  assert.equal(status.granted, false);
  assert.equal(status.needsReconsent, false);
});

test('re-granting after a revoke clears the revocation', async () => {
  consentRow = {
    userId: 1,
    grantedAt: new Date('2026-01-01T00:00:00Z'),
    revokedAt: new Date('2026-02-01T00:00:00Z'),
    policyVersion: CURRENT_POLICY_VERSION,
  };
  const status = await grantConsentService(1);
  assert.equal(status.granted, true);
  assert.equal(consentRow.revokedAt, null);
});

test('revoking with nothing on record is a 404, not a silent success', async () => {
  consentRow = null;
  await assert.rejects(
    () => revokeConsentService(1),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});
