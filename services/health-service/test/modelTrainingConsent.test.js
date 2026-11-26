import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const userId = 42;
const version = 'model-training-2026-11-26';
const deviceConsent = {
  grantedAt: new Date('2026-10-01T00:00:00Z'),
  revokedAt: null,
  policyVersion: 'device-v1',
  platform: 'android',
};

function call(handler, body, params) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return handler({ userId, body, params }, res).then(() => res);
}

test('optional model-training consent through the public and internal controllers', async (t) => {
  let row = null;
  const events = [];
  const prisma = {
    healthConsent: { findUnique: async () => deviceConsent },
    modelTrainingConsent: {
      findUnique: async ({ where }) => where.userId === row?.userId ? row : null,
      upsert: async ({ create, update }) => {
        row = row ? { ...row, ...update } : create;
        return row;
      },
      updateManyAndReturn: async ({ where, data }) => {
        if (!row || row.userId !== where.userId || row.revokedAt !== where.revokedAt) return [];
        row = { ...row, ...data };
        return [row];
      },
    },
  };

  t.mock.module('../db/prisma.js', { exports: { default: prisma } });
  t.mock.module('../services/auditService.js', { exports: { recordAudit() {} } });
  t.mock.module('../utils/analytics.js', {
    exports: { track: (...args) => events.push(args) },
  });
  const controller = await import('../controllers/modelTrainingConsentController.js');
  const { getConsentStatusService } = await import('../services/consentService.js');
  const readInternal = (targetId = String(userId)) =>
    call(controller.getConsentInternal, undefined, { userId: targetId });

  await t.test('defaults to denied and keeps an existing device consent usable', async () => {
    const expected = { scope: 'model_training', granted: false, policyVersion: version };
    assert.deepEqual((await call(controller.getConsent)).payload.data, expected);
    assert.deepEqual((await call(controller.revokeConsent)).payload.data, expected);
    assert.deepEqual((await readInternal()).payload.data, expected);
    assert.equal((await readInternal('42abc')).statusCode, 400);
    assert.deepEqual(await getConsentStatusService(userId), { granted: true, ...deviceConsent });
    assert.equal(row, null);
    assert.deepEqual(events, []);
  });

  await t.test('requires the current policy version and grants with version-only telemetry', async () => {
    assert.equal((await call(controller.grantConsent)).statusCode, 400);
    const stale = await call(controller.grantConsent, { policyVersion: 'old-policy' });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.payload.currentVersion, version);
    assert.equal(row, null);
    assert.deepEqual(events, []);

    const granted = await call(controller.grantConsent, { policyVersion: version });
    assert.equal(granted.statusCode, 201);
    assert.equal(granted.payload.data.granted, true);
    assert.equal(granted.payload.data.policyVersion, version);
    assert.ok(granted.payload.data.grantedAt instanceof Date);
    assert.equal(granted.payload.data.revokedAt, null);
    assert.deepEqual(events, [['model_training_consent_granted', userId, { version }]]);
  });

  await t.test('exposes the withdrawal time internally and preserves it on retry', async () => {
    const revoked = await call(controller.revokeConsent);
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.payload.data.granted, false);
    assert.ok(revoked.payload.data.revokedAt instanceof Date);
    assert.deepEqual((await call(controller.getConsent)).payload.data, revoked.payload.data);
    assert.deepEqual((await readInternal()).payload.data, revoked.payload.data);
    assert.deepEqual((await call(controller.revokeConsent)).payload.data, revoked.payload.data);
    assert.deepEqual(events.slice(1), [['model_training_consent_revoked', userId, { version }]]);
  });

  await t.test('re-grant clears withdrawal and restores eligibility', async () => {
    await call(controller.grantConsent, { policyVersion: version });
    const { payload: { data } } = await readInternal();
    assert.equal(data.granted, true);
    assert.equal(data.revokedAt, null);
    assert.equal((await readInternal('43')).payload.data.granted, false);
    assert.deepEqual(await getConsentStatusService(userId), { granted: true, ...deviceConsent });
  });
});

test('model-training consent is used only on its own health routes', () => {
  const routes = readFileSync(new URL('../routes/health.js', import.meta.url), 'utf8');
  const consentRoutes = routes.split(/\r?\n/).filter((line) => line.startsWith('router.') &&
    /modelTrainingConsent|\/model-training\/consent/i.test(line));
  assert.deepEqual(consentRoutes, [
    "router.get('/model-training/consent', requireAuth, modelTrainingConsentCtrl.getConsent);",
    "router.post('/model-training/consent', requireAuth, requireAdult, modelTrainingConsentCtrl.grantConsent);",
    "router.delete('/model-training/consent', requireAuth, modelTrainingConsentCtrl.revokeConsent);",
    "router.get('/internal/model-training/consent/:userId', requireInternal, modelTrainingConsentCtrl.getConsentInternal);",
  ]);
});
