// Cycle tracking. Run with:
//   node --experimental-test-module-mocks --test
//
// This feature reverses a recorded architectural decision (FR-27, 2026-09-08,
// which kept zero cycle columns server-side). The tests that matter most are
// therefore the ones covering the containments that make the reversal
// reversible: consent gating, and the rule that cycle data reaches training
// only through ProgrammingMode.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let healthConsent = null;
let cycleProfile = null;
let personalisation = null;
let phases = [];
let nextPhaseId = 1;

let svc;

function resetFakes() {
  healthConsent = { userId: 1, revokedAt: null, scopes: ['logs'] };
  cycleProfile = null;
  personalisation = null;
  phases = [];
  nextPhaseId = 1;
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
          this.cycleTrackingProfile = {
            findUnique: async () => cycleProfile,
            upsert: async ({ update, create }) => {
              cycleProfile = cycleProfile ? { ...cycleProfile, ...update } : { ...create };
              return cycleProfile;
            },
            update: async ({ data }) => {
              cycleProfile = { ...cycleProfile, ...data };
              return cycleProfile;
            },
            updateMany: async ({ data }) => {
              if (cycleProfile) cycleProfile = { ...cycleProfile, ...data };
              return { count: cycleProfile ? 1 : 0 };
            },
            deleteMany: async () => {
              cycleProfile = null;
              return { count: 1 };
            },
          };
          this.cyclePhaseEntry = {
            create: async ({ data }) => {
              const row = { id: nextPhaseId++, ...data };
              phases.push(row);
              return row;
            },
            findFirst: async () =>
              [...phases].sort((a, b) => b.startDate - a.startDate)[0] ?? null,
            findMany: async () => phases,
            deleteMany: async () => {
              phases = [];
              return { count: 1 };
            },
          };
          this.personalisationProfile = {
            findUnique: async () => personalisation,
            upsert: async ({ update, create }) => {
              personalisation = personalisation ? { ...personalisation, ...update } : { ...create };
              return personalisation;
            },
          };
          this.$transaction = async (ops) => Promise.all(ops);
        }
      },
      Prisma: {},
    },
  });
  svc = await import('../services/cycleTrackingService.js');
});

test('consent requires health consent first, and says so', async () => {
  resetFakes();
  healthConsent = null;
  await assert.rejects(
    () => svc.grantCycleConsentService(1),
    (err) => {
      assert.equal(err.code, 'HEALTH_CONSENT_REQUIRED');
      return true;
    }
  );
});

test('granting adds a scope rather than a second consent record', async () => {
  // One withdrawal, not two the user has to find separately: revoking health
  // consent must take this with it.
  resetFakes();
  await svc.grantCycleConsentService(1, { privacyVersion: 'v1' });
  assert.ok(healthConsent.scopes.includes('cycle_tracking'));
  assert.ok(healthConsent.scopes.includes('logs'), 'existing scopes preserved');
  assert.ok(cycleProfile.consentAt);
});

test('revoking health consent entirely revokes cycle tracking too', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  healthConsent.revokedAt = new Date();
  assert.equal(await svc.hasCycleConsentService(1), false);
});

test('revoking cycle consent does NOT delete the data', async () => {
  // Switching a feature off and destroying months of records are different
  // intentions. Conflating them would delete data the user only meant to stop
  // adding to.
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: '2026-09-01', phase: 'menstrual' });

  await svc.revokeCycleConsentService(1);

  assert.equal(await svc.hasCycleConsentService(1), false);
  assert.equal(phases.length, 1, 'history survives an opt-out');
});

test('deleting is explicit and removes everything', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: '2026-09-01', phase: 'menstrual' });

  await svc.deleteAllCycleDataService(1);

  assert.equal(phases.length, 0);
  assert.equal(cycleProfile, null);
});

test('implausible cycle lengths are rejected as typos', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await assert.rejects(() => svc.updateProfileService(1, { averageCycleLengthDays: 3 }));
  await assert.rejects(() => svc.updateProfileService(1, { averageCycleLengthDays: 400 }));
  await assert.rejects(() => svc.updateProfileService(1, { averagePeriodLengthDays: 40 }));
});

test('a logged period updates the last-period date', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: '2026-09-10', phase: 'menstrual' });
  assert.equal(
    cycleProfile.lastPeriodStartDate.toISOString().slice(0, 10),
    '2026-09-10'
  );
});

test('a logged phase is always user_logged, never predicted', async () => {
  // A prediction must never be shown back as something she reported.
  resetFakes();
  await svc.grantCycleConsentService(1);
  const entry = await svc.logPhaseService(1, { startDate: '2026-09-10', phase: 'luteal' });
  assert.equal(entry.source, 'user_logged');
});

test('cycle data reaches training ONLY through ProgrammingMode', async () => {
  // The containment that makes this whole feature reversible: switch the flag
  // off and the training engine keeps reading the same enum it always did.
  resetFakes();
  await svc.grantCycleConsentService(1);

  await svc.logPhaseService(1, { startDate: '2026-09-10', phase: 'menstrual' });
  assert.equal(personalisation.programmingMode, 'low_impact_recovery');

  await svc.logPhaseService(1, { startDate: '2026-09-16', phase: 'follicular' });
  assert.equal(personalisation.programmingMode, 'female_default');
});

test('without consent nothing touches the programming mode', async () => {
  resetFakes();
  personalisation = { userId: 1, programmingMode: 'neutral' };
  const result = await svc.syncProgrammingModeService(1);
  assert.equal(result, null);
  assert.equal(personalisation.programmingMode, 'neutral');
});

test('a user-chosen low-impact mode is never downgraded by cycle data', async () => {
  // Someone who set low-impact after an injury must not be quietly moved off
  // it because their cycle phase advanced. Cycle data may raise caution; it
  // must not remove it.
  resetFakes();
  await svc.grantCycleConsentService(1);
  personalisation = { userId: 1, programmingMode: 'low_impact_recovery', injuryZones: ['knee'] };

  await svc.logPhaseService(1, { startDate: '2026-09-16', phase: 'follicular' });

  assert.equal(personalisation.programmingMode, 'low_impact_recovery');
});
