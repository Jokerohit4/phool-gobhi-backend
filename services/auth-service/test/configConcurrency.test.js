// Optimistic concurrency (expectedUpdatedAt) on the admin-edited singleton
// config rows: app-config blob, launch gate, OTP provider, profile-completion
// bonus. The prisma mock is STATEFUL and its updateMany is a real
// compare-and-set, so a double save genuinely races the way two admins would.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const T0 = new Date('2026-10-01T10:00:00.000Z');
const rows = {};
const calls = { upsert: 0, updateMany: 0 };

function singleton(name) {
  return {
    findUnique: async () => (rows[name] ? { ...rows[name] } : null),
    upsert: async ({ create, update }) => {
      calls.upsert++;
      rows[name] = rows[name]
        ? { ...rows[name], ...update, updatedAt: new Date() }
        : { ...create, updatedAt: new Date() };
      return { ...rows[name] };
    },
    updateMany: async ({ where, data }) => {
      calls.updateMany++;
      const r = rows[name];
      if (!r || r.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
      rows[name] = { ...r, ...data };
      return { count: 1 };
    },
  };
}

let ctl, otp, bonus;
test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.appVersionSetting = singleton('app');
          this.launchGateSetting = singleton('gate');
          this.otpProviderSetting = singleton('otp');
          this.profileCompletionBonusSetting = singleton('bonus');
          this.appConfigHistory = { create: async () => ({}) };
        }
      },
      Prisma: {},
    },
  });
  ctl = await import('../controllers/authController.js');
  otp = await import('../services/otpProviderService.js');
  bonus = await import('../services/profileCompletionBonusService.js');
});

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const call = async (fn, body = {}) => {
  const res = fakeRes();
  await fn({ query: {}, body, user: { id: 7 } }, res);
  return res;
};
function reset() {
  for (const k of Object.keys(rows)) delete rows[k];
  calls.upsert = 0;
  calls.updateMany = 0;
}

const CONFLICT = {
  error: 'This setting was changed by someone else. Reload and try again.',
  errorCode: 'CONFIG_CONFLICT',
};

test('app-config GET returns updatedAt (null before the first save)', async () => {
  reset();
  assert.equal((await call(ctl.getAppConfigAdmin)).body.updatedAt, null);
  rows.app = { id: 1, config: { social: { enabled: true } }, updatedAt: T0 };
  const res = await call(ctl.getAppConfigAdmin);
  assert.equal(res.body.updatedAt, T0);
  assert.deepEqual(res.body.data, { social: { enabled: true } });
});

test('app-config PUT: matching expectedUpdatedAt writes and returns the new updatedAt', async () => {
  reset();
  rows.app = { id: 1, config: { a: 1 }, updatedAt: T0 };
  const res = await call(ctl.updateAppConfigAdmin, { config: { b: 2 }, expectedUpdatedAt: T0.toISOString() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, { b: 2 });
  assert.ok(res.body.updatedAt.getTime() > T0.getTime());
  assert.deepEqual(rows.app.config, { b: 2 });
});

test('app-config PUT: stale expectedUpdatedAt -> 409, nothing written', async () => {
  reset();
  rows.app = { id: 1, config: { a: 1 }, updatedAt: T0 };
  const stale = new Date(T0.getTime() - 5000).toISOString();
  const res = await call(ctl.updateAppConfigAdmin, { config: { b: 2 }, expectedUpdatedAt: stale });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { ...CONFLICT, currentUpdatedAt: T0.toISOString() });
  assert.deepEqual(rows.app.config, { a: 1 });
  assert.equal(calls.upsert, 0);
});

test('app-config PUT: absent expectedUpdatedAt behaves as before (plain upsert)', async () => {
  reset();
  rows.app = { id: 1, config: { a: 1 }, updatedAt: T0 };
  const res = await call(ctl.updateAppConfigAdmin, { config: { b: 2 } });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.upsert, 1);
  assert.equal(calls.updateMany, 0);
  assert.deepEqual(rows.app.config, { b: 2 });
});

test('app-config PUT: two admins save from the same page load - second one conflicts', async () => {
  reset();
  rows.app = { id: 1, config: { a: 1 }, updatedAt: T0 };
  const body = (n) => ({ config: { n }, expectedUpdatedAt: T0.toISOString() });
  const [r1, r2] = await Promise.all([call(ctl.updateAppConfigAdmin, body(1)), call(ctl.updateAppConfigAdmin, body(2))]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409]);
  const winner = r1.statusCode === 200 ? 1 : 2;
  assert.deepEqual(rows.app.config, { n: winner });
});

test('app-config PUT: malformed expectedUpdatedAt -> 400', async () => {
  reset();
  rows.app = { id: 1, config: {}, updatedAt: T0 };
  const res = await call(ctl.updateAppConfigAdmin, { config: { b: 2 }, expectedUpdatedAt: 'not-a-date' });
  assert.equal(res.statusCode, 400);
});

test('app-config PUT: expectedUpdatedAt when no row exists -> 409 with null current', async () => {
  reset();
  const res = await call(ctl.updateAppConfigAdmin, { config: { b: 2 }, expectedUpdatedAt: T0.toISOString() });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.currentUpdatedAt, null);
});

test('launch gate: GET returns updatedAt; PUT honours expectedUpdatedAt', async () => {
  reset();
  rows.gate = { id: 1, enabled: false, launchAt: null, updatedAt: T0 };
  assert.equal((await call(ctl.getLaunchGateAdmin)).body.updatedAt, T0);
  const stale = await call(ctl.updateLaunchGateAdmin, { enabled: true, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.errorCode, 'CONFIG_CONFLICT');
  assert.equal(rows.gate.enabled, false);
  const ok = await call(ctl.updateLaunchGateAdmin, { enabled: true, expectedUpdatedAt: T0.toISOString() });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data.enabled, true);
  const legacy = await call(ctl.updateLaunchGateAdmin, { enabled: false });
  assert.equal(legacy.statusCode, 200);
});

test('otp provider: stale -> 409 no write; double save conflicts; absent -> upsert', async () => {
  reset();
  rows.otp = { id: 1, provider: 'firebase', updatedAt: T0 };
  await assert.rejects(
    otp.updateOtpProvider('fast2sms', 1, '2020-01-01T00:00:00.000Z'),
    (e) => e.status === 409 && e.errorCode === 'CONFIG_CONFLICT',
  );
  assert.equal(rows.otp.provider, 'firebase');
  const results = await Promise.allSettled([
    otp.updateOtpProvider('fast2sms', 1, T0.toISOString()),
    otp.updateOtpProvider('skip', 1, T0.toISOString()),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const res = await call(ctl.updateOtpConfigAdmin, { provider: 'firebase' });
  assert.equal(res.statusCode, 200);
});

test('otp provider controller returns the 409 body', async () => {
  reset();
  rows.otp = { id: 1, provider: 'firebase', updatedAt: T0 };
  const res = await call(ctl.updateOtpConfigAdmin, { provider: 'skip', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { ...CONFLICT, currentUpdatedAt: T0.toISOString() });
});

test('profile-completion bonus: stale -> 409 no write; matching -> ok; absent -> unchanged', async () => {
  reset();
  rows.bonus = { id: 1, amount: 20, updatedAt: T0 };
  const stale = await call(ctl.updateProfileCompletionBonusAdmin, { amount: 50, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(stale.statusCode, 409);
  assert.equal(rows.bonus.amount, 20);
  const ok = await call(ctl.updateProfileCompletionBonusAdmin, { amount: 50, expectedUpdatedAt: T0.toISOString() });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data.amount, 50);
  const legacy = await call(ctl.updateProfileCompletionBonusAdmin, { amount: 60 });
  assert.equal(legacy.statusCode, 200);
  assert.equal(rows.bonus.amount, 60);
  assert.equal((await call(ctl.updateProfileCompletionBonusAdmin, { amount: -1 })).statusCode, 400);
  await assert.doesNotReject(bonus.loadProfileCompletionBonusAdmin());
});
