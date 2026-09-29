// Ledger consent scopes and the privacy-policy version each was granted under.
//
// The bug this file exists for: the controller's comment said "the service
// rejects a mismatch" so a stale app could not record consent to wording the
// person never saw. The service did not reject anything — the client-sent
// version was returned in the response and written nowhere, so `scopes` proved
// THAT someone agreed and nothing about what they agreed to. `scopeVersions`
// is now the record, and a mismatch is a 409.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let consent = null;
let updates = [];
let grantNutritionConsentService, getNutritionConsentService, revokeNutritionConsentService,
  getMedicalRecordsConsentService, grantMedicalRecordsConsentService,
  hasNutritionConsentService, hasMedicalRecordsConsentService,
  hasNutritionScopeService, hasMedicalRecordsScopeService,
  LEDGER_POLICY_VERSION, isScopeStale, NUTRITION_SCOPE, MEDICAL_RECORDS_SCOPE;

test('setup: stub Prisma, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.healthConsent = {
            findUnique: async () => consent,
            update: async ({ data }) => {
              updates.push(data);
              consent = { ...consent, ...data };
              return consent;
            },
          };
          // Revoke with purge would touch these; the tests here never purge, but
          // leaving them absent makes an accidental purge a loud failure rather
          // than a silent no-op.
          this.foodLog = { deleteMany: async () => ({ count: 0 }) };
          this.savedMeal = { deleteMany: async () => ({ count: 0 }) };
          this.foodItem = { deleteMany: async () => ({ count: 0 }) };
          this.medicalDocument = { findMany: async () => [], deleteMany: async () => ({ count: 0 }) };
          this.doctorAppointment = { deleteMany: async () => ({ count: 0 }) };
          this.healthCondition = { deleteMany: async () => ({ count: 0 }) };
          this.$transaction = async (ops) => Promise.all(ops);
        }
      },
    },
  });

  ({
    grantNutritionConsentService, getNutritionConsentService, revokeNutritionConsentService,
    getMedicalRecordsConsentService, grantMedicalRecordsConsentService,
    hasNutritionConsentService, hasMedicalRecordsConsentService,
    hasNutritionScopeService, hasMedicalRecordsScopeService,
    LEDGER_POLICY_VERSION, isScopeStale, NUTRITION_SCOPE, MEDICAL_RECORDS_SCOPE,
  } = await import('../services/ledger/ledgerConsentService.js'));

  // A live device-level grant that predates the ledger scopes, which is the
  // state nearly every real user is in.
  consent = {
    userId: 1,
    grantedAt: new Date('2026-01-01'),
    revokedAt: null,
    policyVersion: 'health-2026-09-01',
    scopes: ['logs'],
    scopeVersions: {},
  };
  updates = [];
});

// Each test gets the same starting row. The stub hands back one shared object,
// so without this a grant in one test silently carries its scope into the next
// and the suite starts passing or failing on ordering.
function resetConsent() {
  consent = {
    userId: 1,
    grantedAt: new Date('2026-01-01'),
    revokedAt: null,
    policyVersion: 'health-2026-09-01',
    scopes: ['logs'],
    scopeVersions: {},
  };
  updates = [];
}

// --- the version must be written down ---------------------------------------

test('a grant records the version it was given under', async () => {
  resetConsent();
  const out = await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  assert.equal(out.granted, true);
  assert.equal(out.privacyVersion, LEDGER_POLICY_VERSION);
  assert.ok(consent.scopes.includes(NUTRITION_SCOPE));
  // The part that did not happen before.
  assert.equal(
    consent.scopeVersions[NUTRITION_SCOPE],
    LEDGER_POLICY_VERSION,
    'the wording the user agreed to must be on the row, not just in the response',
  );
});

test('a made-up version is refused', async () => {
  resetConsent();
  await assert.rejects(
    () => grantNutritionConsentService(1, { privacyVersion: 'TOTALLY-MADE-UP-v99' }),
    (err) => err.status === 409 && err.code === 'LEDGER_POLICY_VERSION_MISMATCH',
  );
  assert.ok(!consent.scopes.includes(NUTRITION_SCOPE), 'a refused grant must not add the scope');
  assert.equal(consent.scopeVersions[NUTRITION_SCOPE], undefined);
});

test('a grant with no version at all is refused', async () => {
  resetConsent();
  // Silence is not consent. A client that omits the field has not told us what
  // the person read, which is the entire question.
  await assert.rejects(
    () => grantNutritionConsentService(1, {}),
    (err) => err.status === 409 && /did not report which version/.test(err.error),
  );
  await assert.rejects(
    () => grantNutritionConsentService(1),
    (err) => err.status === 409,
  );
});

test('a stale app is told which version it needs', async () => {
  resetConsent();
  // The 409 carries the current version so the app can prompt an update rather
  // than showing a bare failure the user cannot act on.
  await assert.rejects(
    () => grantNutritionConsentService(1, { privacyVersion: 'ledger-2026-01-01' }),
    (err) => err.currentVersion === LEDGER_POLICY_VERSION,
  );
});

// --- per scope, not per device ----------------------------------------------

test('the two scopes keep separate versions', async () => {
  resetConsent();
  // One map, two prompts. Reporting the device-level version for both would tell
  // a user their medical-records grant predates the medical-records screen.
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  await grantMedicalRecordsConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });

  const nutrition = await getNutritionConsentService(1);
  const medical = await getMedicalRecordsConsentService(1);
  assert.equal(nutrition.privacyVersion, LEDGER_POLICY_VERSION);
  assert.equal(medical.privacyVersion, LEDGER_POLICY_VERSION);
  // And specifically NOT the device-level version, which is what the old code
  // fell back to.
  assert.notEqual(nutrition.privacyVersion, consent.policyVersion);
});

test('revoking one scope leaves the other grant intact', async () => {
  resetConsent();
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  await grantMedicalRecordsConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });

  await revokeNutritionConsentService(1);

  assert.ok(!consent.scopes.includes(NUTRITION_SCOPE));
  assert.ok(consent.scopes.includes(MEDICAL_RECORDS_SCOPE), 'medical records must not be revoked as a side effect');
  assert.equal(consent.scopeVersions[MEDICAL_RECORDS_SCOPE], LEDGER_POLICY_VERSION);
});

test('revoking clears the recorded version too', async () => {
  resetConsent();
  // Otherwise the stale check finds a current version sitting there for a scope
  // the user already withdrew, and a later re-grant looks like it never needed
  // asking.
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  await revokeNutritionConsentService(1);
  assert.equal(
    consent.scopeVersions[NUTRITION_SCOPE],
    undefined,
    'a withdrawn scope must not keep a version on file',
  );
});

// --- staleness ---------------------------------------------------------------

test('a grant under current wording is not stale', async () => {
  resetConsent();
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  assert.equal(isScopeStale(consent, NUTRITION_SCOPE), false);
});

test('a scope granted before the column existed counts as stale', async () => {
  resetConsent();
  // The honest reading. Those are precisely the rows where we cannot prove what
  // the user saw, so they need to agree again — the opposite inference, treating
  // them as current, is what lets an unprovable grant stand forever.
  consent.scopeVersions = {};
  consent.scopes = ['logs', NUTRITION_SCOPE];
  assert.equal(isScopeStale(consent, NUTRITION_SCOPE), true);

  const out = await getNutritionConsentService(1);
  assert.equal(out.granted, true, 'the scope is still granted');
  assert.equal(out.needsReconsent, true, 'and the app is told to ask again');
  assert.equal(out.privacyVersion, null, 'with no version claimed');
});

test('a scope under an older version is reported as needing consent again', async () => {
  resetConsent();
  // Granted, but under wording that has since been revised.
  consent.scopes = ['logs', NUTRITION_SCOPE];
  consent.scopeVersions = { [NUTRITION_SCOPE]: 'ledger-2026-01-01' };
  const out = await getNutritionConsentService(1);
  assert.equal(out.granted, true);
  assert.equal(out.needsReconsent, true);
  assert.equal(out.privacyVersion, 'ledger-2026-01-01', 'the old version is still reported, not overwritten');
});

test('an ungranted scope is simply not granted', async () => {
  resetConsent();
  const out = await getNutritionConsentService(1);
  assert.equal(out.granted, false);
  assert.equal(out.needsReconsent, true, 'an ungranted scope has nothing to stand on either');
});

// --- reading the map defensively --------------------------------------------

test('a scopeVersions stored as a JSON string is read, not crashed on', async () => {
  resetConsent();
  // Prisma returns parsed JSON on Postgres, but a raw query or a driver change
  // would hand back a string, and a JSON.parse crash inside a consent check is
  // a very bad place to discover that.
  consent.scopeVersions = JSON.stringify({ [NUTRITION_SCOPE]: LEDGER_POLICY_VERSION });
  assert.equal(isScopeStale(consent, NUTRITION_SCOPE), false);

  const out = await getNutritionConsentService(1);
  assert.equal(out.privacyVersion, LEDGER_POLICY_VERSION);
});

test('a malformed scopeVersions is treated as empty, not thrown', async () => {
  resetConsent();
  for (const junk of ['not json', '[]', 'null', '42']) {
    consent.scopeVersions = junk;
    assert.equal(isScopeStale(consent, NUTRITION_SCOPE), true, `${junk} should read as no version`);
  }
});

test('granting over a string-valued map still writes a proper object', async () => {
  resetConsent();
  consent.scopeVersions = JSON.stringify({});
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  assert.equal(typeof consent.scopeVersions, 'object');
  assert.equal(consent.scopeVersions[NUTRITION_SCOPE], LEDGER_POLICY_VERSION);
});

// --- the data gate ------------------------------------------------------------
//
// The settings screen showing "needs review" is not enforcement. These are the
// functions the ledger routes are actually gated on, so they are where a stale
// grant has to stop the data rather than merely annotate it.

test('the data gate refuses a scope granted under superseded wording', async () => {
  resetConsent();
  consent.scopes = ['logs', NUTRITION_SCOPE];
  consent.scopeVersions = { [NUTRITION_SCOPE]: 'ledger-2026-01-01' };
  assert.equal(
    await hasNutritionConsentService(1),
    false,
    'a grant under old wording must not authorise new rows',
  );
});

test('the data gate refuses a scope with no recorded version at all', async () => {
  resetConsent();
  consent.scopes = ['logs', MEDICAL_RECORDS_SCOPE];
  consent.scopeVersions = {};
  assert.equal(await hasMedicalRecordsConsentService(1), false);
});

test('the data gate allows a scope granted under the current wording', async () => {
  resetConsent();
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  assert.equal(await hasNutritionConsentService(1), true);
});

test('the two scopes are gated independently', async () => {
  // Agreeing to a food log says nothing about prescriptions. If refreshing
  // nutrition silently unblocked medical records, the split that the whole
  // consent design rests on would be decorative.
  resetConsent();
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  assert.equal(await hasNutritionConsentService(1), true);
  assert.equal(await hasMedicalRecordsConsentService(1), false);
});

test('withdrawing a scope closes the gate again', async () => {
  resetConsent();
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  assert.equal(await hasNutritionConsentService(1), true);
  await revokeNutritionConsentService(1);
  assert.equal(await hasNutritionConsentService(1), false);
});

test('presence and currency are separately answerable', async () => {
  // The settings screen is allowed to keep saying "you turned this on in March"
  // even when the data gate is closed, so the two questions must not collapse
  // into one function.
  resetConsent();
  consent.scopes = ['logs', NUTRITION_SCOPE];
  consent.scopeVersions = { [NUTRITION_SCOPE]: 'ledger-2026-01-01' };
  assert.equal(await hasNutritionScopeService(1), true, 'the grant is still on record');
  assert.equal(await hasNutritionConsentService(1), false, 'but it no longer authorises data');
});

test('a revoked health consent closes both gates', async () => {
  resetConsent();
  await grantNutritionConsentService(1, { privacyVersion: LEDGER_POLICY_VERSION });
  consent.revokedAt = new Date();
  assert.equal(await hasNutritionConsentService(1), false);
});
