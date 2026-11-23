// `coachJourney` and `healthVault` were retired as toggles (permanently on).
// Installed apps still read `features.coachJourney.enabled` and
// `features.healthVault.enabled` from GET /app-config and treat a MISSING key as
// OFF, so the public response must keep serving both as constant true, whatever
// is stored and whatever an un-updated admin app writes. Pinned here, together
// with the replacement `reportSubscription` flag and the dependency graph.
process.env.AUTH_CACHE_FORCE = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_FLAGS,
  LEGACY_ALWAYS_ON_FLAGS,
  defaultFeatures,
  flagNames,
  flagRegistry,
  validateFeaturePayload,
  stripLegacyFlags,
} from '../config/featureFlagRegistry.js';

const RETIRED = ['coachJourney', 'healthVault'];

const db = { config: null, fail: false, written: null, history: [] };
let ctl;
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const call = async (fn, req = {}) => {
  const res = fakeRes();
  await fn({ query: {}, body: {}, user: { id: 1 }, ...req }, res);
  return res;
};

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.appVersionSetting = {
            findUnique: async () => {
              if (db.fail) throw new Error('db down');
              return db.config ? { config: db.config } : null;
            },
            upsert: async ({ update }) => { db.written = update.config; return { config: update.config, updatedAt: null }; },
          };
          this.otpProviderSetting = { findUnique: async () => null, upsert: async () => ({}) };
          this.profileCompletionBonusSetting = { findUnique: async () => null, upsert: async () => ({}) };
          this.launchGateSetting = { findUnique: async () => null, upsert: async () => ({}) };
          this.appConfigHistory = { create: async ({ data }) => { db.history.push(data); return {}; } };
        }
      },
      Prisma: {},
    },
  });
  ctl = await import('../controllers/authController.js');
});

async function reset() {
  Object.assign(db, { config: null, fail: false, written: null, history: [] });
  const { appConfigBundleCache } = await import('../utils/settingsCaches.js');
  appConfigBundleCache.clear();
}

// (a) /app-config keeps both legacy keys ------------------------------------

test('app-config still emits coachJourney and healthVault as { enabled: true } with no stored config', async () => {
  await reset();
  const res = await call(ctl.getAppConfig);
  assert.deepEqual(res.body.features.coachJourney, { enabled: true });
  assert.deepEqual(res.body.features.healthVault, { enabled: true });
  assert.ok(res.body.flagsKnown.includes('coachJourney'));
  assert.ok(res.body.flagsKnown.includes('healthVault'));
  assert.deepEqual(
    LEGACY_ALWAYS_ON_FLAGS.map((f) => f.clientKey),
    ['coachJourneyEnabled', 'healthVaultEnabled'],
  );
});

test('app-config emits the legacy keys even when the config read fails', async () => {
  await reset();
  db.fail = true;
  const res = await call(ctl.getAppConfig);
  assert.deepEqual(res.body.features.coachJourney, { enabled: true });
  assert.deepEqual(res.body.features.healthVault, { enabled: true });
});

// (b) stored / admin-written values for the retired flags are ignored --------

test('a stored enabled:false for a retired flag cannot turn it off', async () => {
  await reset();
  db.config = { features: { coachJourney: { enabled: false }, healthVault: { enabled: false } } };
  const res = await call(ctl.getAppConfig);
  assert.deepEqual(res.body.features.coachJourney, { enabled: true });
  assert.deepEqual(res.body.features.healthVault, { enabled: true });
});

test('a garbage stored value for a retired flag is overridden too', async () => {
  await reset();
  db.config = { features: { coachJourney: null, healthVault: 'false' } };
  const res = await call(ctl.getAppConfig);
  assert.deepEqual(res.body.features.coachJourney, { enabled: true });
  assert.deepEqual(res.body.features.healthVault, { enabled: true });
});

test('an admin PUT that still carries the retired flags succeeds and does not store or audit them', async () => {
  await reset();
  db.config = { features: { coachJourney: { enabled: true } } };
  const res = await call(ctl.updateAppConfigAdmin, {
    body: { config: { features: { coachJourney: { enabled: false }, healthVault: { enabled: false }, referral: { enabled: true } } } },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(db.written.features), ['referral']);
  assert.deepEqual(res.body.changedFlags, ['referral']);
  assert.deepEqual(db.history[0].changedFlags, ['referral']);
});

test('the retired flags are accepted in a payload regardless of shape; a genuinely unknown flag is still rejected', () => {
  assert.deepEqual(
    validateFeaturePayload({ coachJourney: { enabled: false }, healthVault: 'nonsense' }),
    { unknown: [], malformed: [] },
  );
  assert.deepEqual(validateFeaturePayload({ notAFlag: { enabled: true } }).unknown, ['notAFlag']);
});

test('stripLegacyFlags drops only the retired keys and leaves the input untouched', () => {
  const input = { coachJourney: { enabled: true }, buddy: { enabled: true }, healthVault: { enabled: false } };
  assert.deepEqual(stripLegacyFlags(input), { buddy: { enabled: true } });
  assert.equal(Object.keys(input).length, 3);
});

// (c) reportSubscription ------------------------------------------------------

test('reportSubscription is registered, fail-closed, dependency-free and medical', () => {
  const flag = FEATURE_FLAGS.find((f) => f.name === 'reportSubscription');
  assert.ok(flag, 'reportSubscription missing from the registry');
  assert.equal(flag.clientKey, 'reportSubscriptionEnabled');
  assert.equal(flag.group, 'health');
  assert.equal(flag.dataClass, 'medical');
  assert.equal(flag.defaultEnabled, false);
  assert.deepEqual(flag.deps, []);
  assert.deepEqual(defaultFeatures().reportSubscription, { enabled: false });
});

test('app-config serves reportSubscription off by default and on when stored on', async () => {
  await reset();
  assert.deepEqual((await call(ctl.getAppConfig)).body.features.reportSubscription, { enabled: false });
  await reset();
  db.config = { features: { reportSubscription: { enabled: true } } };
  assert.deepEqual((await call(ctl.getAppConfig)).body.features.reportSubscription, { enabled: true });
});

// (d) dependency graph --------------------------------------------------------

test('the retired flags are not registry flags and nothing depends on them', () => {
  const names = flagNames();
  for (const retired of RETIRED) {
    assert.ok(!names.includes(retired), `${retired} must not be a registry flag`);
    assert.ok(!flagRegistry().some((f) => f.name === retired), `${retired} must not be served to the admin portal as a toggle`);
  }
  for (const flag of FEATURE_FLAGS) {
    for (const dep of flag.deps) {
      assert.ok(!RETIRED.includes(dep), `${flag.name} still depends on retired flag ${dep}`);
      assert.ok(names.includes(dep), `${flag.name} depends on unknown flag ${dep}`);
    }
  }
});

test('flags that used to depend on coachJourney are now dependency-free and keep their own default', () => {
  for (const name of ['homeIntroduction', 'weeklySummary', 'referralHomeTrigger', 'coachAssistant']) {
    const flag = FEATURE_FLAGS.find((f) => f.name === name);
    assert.deepEqual(flag.deps, [], `${name}.deps`);
    assert.equal(flag.defaultEnabled, false, `${name}.defaultEnabled`);
  }
});
