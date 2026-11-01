// GET /app-config and /launch-status used to hit the DB on every call (4-5
// queries, appVersionSetting read twice). Pinned here, caching forced ON:
//  - the DB-derived pieces are cached and single-flight; appVersionSetting is
//    read ONCE per load (social derived from the same row);
//  - the caller's app/platform/version comparison is NOT cached;
//  - failures are not cached; every admin writer evicts; an in-flight load
//    that began before a write cannot repopulate stale data;
//  - response bytes are unchanged.
process.env.AUTH_CACHE_FORCE = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = {
  versionReads: 0, otpReads: 0, bonusReads: 0, gateReads: 0,
  config: null, provider: null, bonus: null, gate: null, fail: false, gateFail: false, delayMs: 0,
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

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
              db.versionReads++;
              const snapshot = db.config;
              if (db.delayMs) await tick(db.delayMs);
              if (db.fail) throw new Error('db down');
              return snapshot ? { config: snapshot } : null;
            },
            upsert: async ({ update }) => ({ config: update.config }),
          };
          this.otpProviderSetting = {
            findUnique: async () => { db.otpReads++; return db.provider ? { provider: db.provider } : null; },
            upsert: async ({ update }) => ({ provider: update.provider, updatedAt: null }),
          };
          this.profileCompletionBonusSetting = {
            findUnique: async () => { db.bonusReads++; return db.bonus == null ? null : { amount: db.bonus }; },
            upsert: async ({ update }) => ({ amount: update.amount, updatedAt: null }),
          };
          this.launchGateSetting = {
            findUnique: async () => { db.gateReads++; if (db.gateFail) throw new Error('x'); return db.gate; },
            upsert: async ({ update }) => ({ enabled: update.enabled, launchAt: update.launchAt }),
          };
          this.appConfigHistory = { create: async () => ({}) };
        }
      },
      Prisma: {},
    },
  });
  ctl = await import('../controllers/authController.js');
});

async function reset() {
  Object.assign(db, {
    versionReads: 0, otpReads: 0, bonusReads: 0, gateReads: 0,
    config: null, provider: null, bonus: null, gate: null, fail: false, gateFail: false, delayMs: 0,
  });
  const { appConfigBundleCache, launchGateCache } = await import('../utils/settingsCaches.js');
  appConfigBundleCache.clear();
  launchGateCache.clear();
}

test('app-config: one appVersionSetting read per load; later calls are served from cache', async () => {
  await reset();
  db.config = { social: { enabled: true }, customer: { android: { minVersion: '2.0.0', latestVersion: '3.0.0', updateUrl: 'u', message: 'm' } } };
  const a = await call(ctl.getAppConfig, { query: { app: 'customer', platform: 'android', version: '1.0.0' } });
  await call(ctl.getAppConfig);
  await call(ctl.getAppConfig);
  assert.equal(db.versionReads, 1);
  assert.equal(db.otpReads, 1);
  assert.equal(db.bonusReads, 1);
  assert.equal(a.body.social.enabled, true);
  assert.equal(a.body.features.otp.provider, 'firebase');
  assert.equal(a.body.features.profileCompletionBonus.amount, 20);
});

test('app-config: the version comparison is per request, never cached', async () => {
  await reset();
  db.config = { customer: { android: { minVersion: '2.0.0', latestVersion: '3.0.0', updateUrl: '', message: '' } } };
  const old = await call(ctl.getAppConfig, { query: { app: 'customer', platform: 'android', version: '1.5.0' } });
  const mid = await call(ctl.getAppConfig, { query: { app: 'customer', platform: 'android', version: '2.5.0' } });
  const cur = await call(ctl.getAppConfig, { query: { app: 'customer', platform: 'android', version: '3.0.0' } });
  assert.deepEqual([old.body.forceUpdate, old.body.updateAvailable], [true, true]);
  assert.deepEqual([mid.body.forceUpdate, mid.body.updateAvailable], [false, true]);
  assert.deepEqual([cur.body.forceUpdate, cur.body.updateAvailable], [false, false]);
  assert.equal(db.versionReads, 1);
});

test('app-config: concurrent callers share one load', async () => {
  await reset();
  db.delayMs = 15;
  await Promise.all([call(ctl.getAppConfig), call(ctl.getAppConfig), call(ctl.getAppConfig)]);
  assert.equal(db.versionReads, 1);
});

test('app-config: a failed load is not cached (falls back to defaults, next call retries)', async () => {
  await reset();
  db.fail = true;
  const bad = await call(ctl.getAppConfig);
  assert.equal(bad.body.social.enabled, false);
  assert.equal(bad.body.forceUpdate, false);
  db.fail = false;
  db.config = { social: { enabled: true } };
  const good = await call(ctl.getAppConfig);
  assert.equal(good.body.social.enabled, true);
});

test('app-config: every admin writer evicts', async () => {
  await reset();
  db.config = { social: { enabled: false } };
  assert.equal((await call(ctl.getAppConfig)).body.social.enabled, false);

  db.config = { social: { enabled: true } };
  await call(ctl.updateAppConfigAdmin, { body: { config: { social: { enabled: true } } } });
  assert.equal((await call(ctl.getAppConfig)).body.social.enabled, true);

  db.provider = 'fast2sms';
  await call(ctl.updateOtpConfigAdmin, { body: { provider: 'fast2sms' } });
  assert.equal((await call(ctl.getAppConfig)).body.features.otp.provider, 'fast2sms');

  db.bonus = 55;
  await call(ctl.updateProfileCompletionBonusAdmin, { body: { amount: 55 } });
  assert.equal((await call(ctl.getAppConfig)).body.features.profileCompletionBonus.amount, 55);
});

test('app-config: a load in flight when a write lands cannot repopulate stale data', async () => {
  await reset();
  db.config = { social: { enabled: false } };
  db.delayMs = 20;
  const slow = call(ctl.getAppConfig); // snapshots the OLD row
  await tick(5);
  db.config = { social: { enabled: true } };
  await call(ctl.updateAppConfigAdmin, { body: { config: { social: { enabled: true } } } });
  await slow;
  db.delayMs = 0;
  assert.equal((await call(ctl.getAppConfig)).body.social.enabled, true);
});

test('launch-status: cached, and evicted by updateLaunchGateAdmin', async () => {
  await reset();
  db.gate = { enabled: false, launchAt: null };
  assert.deepEqual((await call(ctl.getLaunchStatus)).body, { launchAt: null, isLive: true });
  await call(ctl.getLaunchStatus);
  assert.equal(db.gateReads, 1);
  db.gate = { enabled: true, launchAt: null };
  await call(ctl.updateLaunchGateAdmin, { body: { enabled: true } });
  assert.deepEqual((await call(ctl.getLaunchStatus)).body, { launchAt: null, isLive: false });
});

test('launch-status: a DB failure still fails closed and is not cached', async () => {
  await reset();
  db.gate = { enabled: false, launchAt: null };
  db.gateFail = true;
  assert.deepEqual((await call(ctl.getLaunchStatus)).body, { launchAt: null, isLive: false });
  db.gateFail = false;
  assert.deepEqual((await call(ctl.getLaunchStatus)).body, { launchAt: null, isLive: true });
});
