import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { defaultCoachingConfig, validateCoachingConfig } from '../services/coachingDefaults.js';
import { coachingCatalog, coachingOffer } from '../services/coachingCatalog.js';

let api, row, history, queue;
const db = {
  coachingCatalogConfig: {
    findUnique: async () => row,
    create: async ({ data }) => { if (row) throw Object.assign(new Error('duplicate'), { code: 'P2002' }); return row = structuredClone(data); },
    updateMany: async ({ where, data }) => { if (row?.version !== where.version) return { count: 0 }; Object.assign(row, structuredClone(data)); return { count: 1 }; },
  },
  coachingCatalogConfigHistory: { create: async ({ data }) => history.push(structuredClone(data)), findMany: async () => [...history].reverse() },
};
db.$transaction = fn => { const next = queue.then(() => fn(db)); queue = next.catch(() => {}); return next; };
before(async t => {
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  api = await import('../services/coachingConfigService.js');
});
function reset() { row = null; history = []; queue = Promise.resolve(); }

test('admin values become the quoted price, visible offering and included quantities', async () => {
  reset();
  const before = await api.getCoachingConfig();
  const oldQuote = coachingCatalog('Gurugram', before.config).plans[0];
  const config = structuredClone(before.config), plan = config.regions.GURUGRAM.plans[0];
  Object.assign(plan, { amountPaise: 555500, freeFormSessions: 5, durationDays: 120, checkInsPerWeek: 2, title: 'Guidance Plus', gymArea: 'Sector 45, Gurugram' });
  const saved = await api.saveCoachingConfig(config, 0, 91);
  assert.equal(saved.version, 1);
  const current = await api.getCoachingConfig();
  const offer = coachingCatalog('Gurugram', current.config).plans[0];
  assert.equal(offer.amountPaise, 555500);assert.equal(offer.freeFormSessions, 5);assert.equal(offer.durationDays, 120);
  assert.ok(offer.features.includes('5 included gym form sessions'));
  assert.ok(offer.features.includes('2 coaching check-ins each week'));
  assert.equal(coachingOffer(plan.product, 'Gurugram', offer.offerId, current.config).title, 'Guidance Plus');
  assert.throws(() => coachingOffer(plan.product, 'Gurugram', oldQuote.offerId, current.config), { status: 409 });
  assert.equal(history[0].updatedBy, 91);
  assert.equal(oldQuote.amountPaise, 449900);
});
test('a stale editor cannot overwrite a newer offering and concurrent first saves produce one version', async () => {
  reset();
  const config = defaultCoachingConfig();
  const results = await Promise.allSettled([api.saveCoachingConfig(config, 0, 1), api.saveCoachingConfig(config, 0, 2)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal(history.length, 1);
  await api.saveCoachingConfig(config, 1, 3);
  await assert.rejects(api.saveCoachingConfig(config, 1, 4), { status: 409 });
  assert.equal(history.length, 2);assert.equal(row.version, 2);
});
test('invalid prices, mismatched benefits and unsupported extra tiers are rejected', () => {
  const checks = [
    config => { config.regions.GURUGRAM.plans[0].amountPaise = -1; },
    config => { config.regions.GURUGRAM.plans[0].freeFormSessions = 21; },
    config => { config.regions.GURUGRAM.plans[0].trainerSupport = false; },
    config => { config.regions.GURUGRAM.plans[0].gymAccess = false; },
    config => { config.regions.GURUGRAM.plans[0].labCredits = 2; },
    config => { config.regions.REST_INDIA.plans[0].gymAccess = true; },
    config => { config.regions.REST_INDIA.addon.enabled = true; },
    config => { config.regions.GURUGRAM.plans.push(structuredClone(config.regions.GURUGRAM.plans[0])); },
  ];
  for (const mutate of checks) { const config = defaultCoachingConfig(); mutate(config); assert.throws(() => validateCoachingConfig(config), { status: 400 }); }
});
test('paused plans and unpublished prices cannot be purchased; free access and guarantee are fixed', () => {
  const config = defaultCoachingConfig();
  config.regions.GURUGRAM.plans[0].enabled = false;
  const offer = coachingCatalog('Gurugram', config).plans[0];
  assert.equal(offer.available, false);assert.equal(offer.guaranteeHours, 72);
  assert.throws(() => coachingOffer(offer.product, 'Gurugram', offer.offerId, config), { status: 409 });
  config.regions.REST_INDIA.plans[0].amountPaise = null;
  assert.equal(coachingCatalog('Other', config).plans[0].available, false);
});
test('only staff can read or publish the catalog configuration', async t => {
  reset();
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  const router = (await import('../routes/coaching.js')).default;
  const { extractUser } = await import('../middleware/requireAuth.js');
  const app = express();app.use(express.json());app.use(extractUser);app.use(router);
  const server = app.listen(0, '127.0.0.1');await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/admin/config`;
    for (const role of ['customer', 'partner']) {
      assert.equal((await fetch(url, { headers: { 'x-user-id': '7', 'x-user-role': role } })).status, 403);
      assert.equal((await fetch(url, { method: 'PUT', headers: { 'x-user-id': '7', 'x-user-role': role, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: defaultCoachingConfig(), expectedVersion: 0 }) })).status, 403);
    }
    assert.equal((await fetch(url, { headers: { 'x-user-id': '91', 'x-user-role': 'gobhi' } })).status, 200);
    const response = await fetch(url, { method: 'PUT', headers: { 'x-user-id': '91', 'x-user-role': 'gobhi', 'Content-Type': 'application/json' }, body: JSON.stringify({ config: defaultCoachingConfig(), expectedVersion: 0 }) });
    assert.equal(response.status, 200);assert.equal(history[0].updatedBy, 91);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
