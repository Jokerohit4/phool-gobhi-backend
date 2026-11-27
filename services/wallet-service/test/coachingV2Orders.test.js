import { afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { coachingCatalog, coachingCatalogV2 } from '../services/coachingCatalog.js';
import { defaultCoachingConfig } from '../services/coachingDefaults.js';
import { defaultCoachingV2Config } from '../services/coachingV2Config.js';

const userId = 7;
const day = 86400000;
let api, configApi, router, extractUser, account, context, config, history, member, orders, grants, records, events, providerOrders, refunds, trackingFailure;
let transactions;

const copy = value => structuredClone(value ?? null);
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (value?.in) return value.in.includes(row[key]);
    if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not;
    if (value?.lte) return row[key] <= value.lte;
    return row[key] === value;
  });
}
function update(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment;
    else if (value && typeof value === 'object' && 'decrement' in value) row[key] -= value.decrement;
    else row[key] = copy(value);
  }
  return copy(row);
}

before(async t => {
  const db = {
    $queryRaw: async () => [],
    $transaction: fn => {
      const result = transactions.then(() => fn(db));
      transactions = result.catch(() => {});
      return result;
    },
    coachingMembership: {
      findUnique: async () => copy(member),
      findMany: async ({ where }) => member && matches(member, where) ? [{ userId: member.userId }] : [],
      upsert: async ({ create, update: data }) => member ? update(member, data) : copy(member = create),
      update: async ({ data }) => update(member, data),
      updateMany: async ({ where, data }) => member && matches(member, where) ? (update(member, data), { count: 1 }) : { count: 0 },
    },
    coachingOrder: {
      findUnique: async ({ where }) => copy(orders.find(row => matches(row, where))),
      findFirst: async ({ where }) => copy(orders.find(row => matches(row, where))),
      create: async ({ data }) => {
        const row = { id: orders.length + 1, status: 'PENDING', ...copy(data) };
        orders.push(row);
        return copy(row);
      },
      update: async ({ where, data }) => update(orders.find(row => matches(row, where)), data),
      updateMany: async ({ where, data }) => {
        const rows = orders.filter(row => matches(row, where));
        for (const row of rows) update(row, data);
        return { count: rows.length };
      },
    },
    coachingCatalogConfig: {
      findUnique: async () => copy(config),
      updateMany: async ({ where, data }) => config?.version === where.version ? (update(config, data), { count: 1 }) : { count: 0 },
    },
    coachingCatalogConfigHistory: {
      create: async ({ data }) => history.push(copy(data)),
    },
    coachingAddonGrant: {
      create: async ({ data }) => grants.push(copy(data)),
      findMany: async () => copy(grants),
    },
    coachingFulfillment: {
      findUnique: async ({ where }) => copy(records.find(row => matches(row, where))),
      findMany: async () => copy(records),
      create: async ({ data }) => { records.push(copy(data)); return data; },
    },
  };
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { get: async url => ({
    data: { data: url.includes('/guidance/internal/') ? context : account },
  }) } } });
  t.mock.module('../utils/analytics.js', { exports: { track: (...args) => {
    events.push(args);
    if (trackingFailure === 'sync') throw new Error('analytics down');
    if (trackingFailure === 'async') return Promise.reject(new Error('analytics down'));
  } } });
  t.mock.module('razorpay', { exports: { default: class {
    orders = { create: async payload => {
      const order = { ...payload, id: `order_${providerOrders.length + 1}` };
      providerOrders.push(order);
      return order;
    } };
    payments = {
      fetch: async id => {
        const providerOrder = providerOrders.find(row => `pay_${row.id}` === id);
        return { id, order_id: providerOrder.id, amount: providerOrder.amount, currency: 'INR', status: 'captured' };
      },
      fetchMultipleRefund: async () => ({ items: copy(refunds) }),
      refund: async (paymentId, data) => {
        const row = { id: `refund_${refunds.length + 1}`, paymentId, status: 'processed', ...data };
        refunds.push(row);
        return row;
      },
    };
  } } });
  api = await import('../services/coachingService.js');
  configApi = await import('../services/coachingConfigService.js');
  router = (await import('../routes/coaching.js')).default;
  ({ extractUser } = await import('../middleware/requireAuth.js'));
});

const originalCoupons = process.env.COACHING_COUPONS_JSON;
beforeEach(() => {
  account = { dateOfBirth: '1995-01-01', isActive: true, name: 'Private Name', phone: '1234567890' };
  context = { hasUploadedReport: false, confirmedDetails: { name: 'Private Name' } };
  config = member = trackingFailure = null;
  orders = []; grants = []; records = []; events = []; providerOrders = []; refunds = []; history = [];
  transactions = Promise.resolve();
  process.env.COACHING_COUPONS_JSON = JSON.stringify({ SAVE10: { percentOff: 10, products: ['ADDON_TRAINER', 'MED_30'] } });
});
afterEach(() => {
  if (originalCoupons === undefined) delete process.env.COACHING_COUPONS_JSON;
  else process.env.COACHING_COUPONS_JSON = originalCoupons;
});

function selection(key, city = 'Gurugram', details = {}) {
  const catalog = coachingCatalogV2(city, config?.config);
  const offer = [...catalog.offers, ...catalog.addons].find(row => row.key === key);
  return { city, offerId: offer?.offerId, ...details };
}
const quote = (key, details) => api.quoteCoachingOrder(key, selection(key, 'Gurugram', details), userId);
const checkout = (key, details, city) => api.createCoachingOrder(userId, key, selection(key, city, details));
const settle = order => api.settleCoachingPayment(order.orderId, `pay_${order.orderId}`);
async function buy(key, details, city) {
  const order = await checkout(key, details, city);
  await settle(order);
  return order;
}

test('HTTP routes keep the legacy catalog and pass v2 quote and checkout inputs through', async () => {
  const app = express();
  app.use(express.json(), extractUser, router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-user-id': String(userId), 'x-user-role': 'customer', 'Content-Type': 'application/json' };
  try {
    const legacy = await fetch(`${url}/catalog?city=Gurgaon`, { headers });
    assert.deepEqual((await legacy.json()).data, coachingCatalog('Gurgaon'));
    const catalog = await fetch(`${url}/catalog/v2?city=Mumbai`, { headers });
    assert.deepEqual((await catalog.json()).data, coachingCatalogV2('Mumbai'));
    const input = { product: 'MED_30', ...selection('MED_30', 'Mumbai'), statedCondition: 'prediabetes' };
    const post = body => fetch(`${url}/orders`, { method: 'POST', headers, body: JSON.stringify(body) });
    const quoted = await post({ ...input, quoteOnly: true });
    assert.equal((await quoted.json()).data.amountPaise, 500000);
    assert.equal((await post({ ...input, expectedAmountPaise: 99 })).status, 409);
    const created = await post({ ...input, expectedAmountPaise: 500000 });
    assert.equal(created.status, 200);
    const order = (await created.json()).data;
    await settle(order);
    assert.equal(member.offerSnapshot.region, 'REST_INDIA');
    assert.equal(member.offerSnapshot.components.trainer.mode, 'online');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('medical checkout requires an adult and an uploaded report or valid stated condition', async () => {
  await assert.rejects(quote('MED_30'), { status: 403 });
  await assert.rejects(checkout('MED_30'), { status: 403 });
  await assert.rejects(quote('MED_30', { statedCondition: 'other' }), { status: 400 });
  context.hasUploadedReport = true;
  assert.equal((await quote('MED_90')).amountPaise, 1300000);
  context.hasUploadedReport = false;
  assert.equal((await quote('MED_30', { statedCondition: 'diabetes' })).amountPaise, 500000);
  account.dateOfBirth = new Date().toISOString();
  await assert.rejects(quote('WELL_GYM'), { status: 403 });
  await assert.rejects(checkout('MED_30', { statedCondition: 'diabetes' }), { status: 403 });
  assert.equal(providerOrders.length, 0);
});

test('add-ons need a matching active family and region and apply medical-only trainer tiers before coupons', async () => {
  await assert.rejects(quote('ADDON_TRAINER', { quantity: 4 }), { status: 403 });
  await assert.rejects(checkout('ADDON_TRAINER', { quantity: 4 }), { status: 403 });
  await buy('MED_30', { statedCondition: 'diabetes' });
  assert.equal((await quote('ADDON_TRAINER', { quantity: 3 })).amountPaise, 150000);
  assert.equal((await quote('ADDON_TRAINER', { quantity: 4 })).amountPaise, 180000);
  const discounted = await quote('ADDON_TRAINER', { quantity: 4, couponCode: ' save10 ' });
  assert.deepEqual(discounted.lines, [
    { type: 'list_price', key: 'ADDON_TRAINER', quantity: 4, unitPaise: 50000, amountPaise: 200000 },
    { type: 'volume_discount', discountPct: 10, amountPaise: -20000 },
    { type: 'coupon_discount', couponCode: 'SAVE10', amountPaise: -18000 },
    { type: 'total', amountPaise: 162000 },
  ]);
  await assert.rejects(quote('ADDON_TRAINER', { quantity: 0 }), { status: 400 });
  await assert.rejects(quote('ADDON_TRAINER', { quantity: 4, expectedAmountPaise: 200000 }), { status: 409 });
  await assert.rejects(checkout('ADDON_TRAINER', { quantity: 4 }, 'Mumbai'), { status: 403 });
  const trainer = await buy('ADDON_TRAINER', { quantity: 4, expectedAmountPaise: 180000 });
  assert.equal(trainer.amountPaise, 180000);
  await settle(trainer);
  assert.equal(member.trainerSessionsRemaining, 8);
  await buy('ADDON_NUTRITIONIST', { quantity: 2 });
  assert.equal(member.nutritionistSessionsRemaining, 2);
  await Promise.all([
    api.consumeSession(userId, 'NUTRITIONIST_SESSION', 91, 'nutrition-0001'),
    api.consumeSession(userId, 'NUTRITIONIST_SESSION', 91, 'nutrition-0001'),
  ]);
  assert.equal(member.nutritionistSessionsRemaining, 1);
  await buy('ADDON_LAB_TEST', { quantity: 2 });
  assert.deepEqual(records.find(row => row.kind === 'LAB_ADDON').details, {
    quantity: 2, region: 'GURUGRAM', availableAt: member.planEndsAt.toISOString(), membershipOrderId: member.activeOrderId,
  });
  await buy('ADDON_GYM', { quantity: 2 });
  assert.equal((await api.coachingGymEntitlement(userId)).sessionsRemaining, 2);
  member.planEndsAt = new Date(0);
  await buy('WELL_TRAINER_GYM_NUTRI');
  assert.equal(member.nutritionistSessionsRemaining, 2);
  assert.equal(member.gymSessionsRemaining, 0);
  assert.equal((await quote('ADDON_TRAINER', { quantity: 4 })).amountPaise, 200000);
  await assert.rejects(quote('ADDON_LAB_TEST'), { status: 403 });
});

test('region and offer hash are rechecked and v1 edits preserve published v2 settings', async () => {
  config = { id: 1, version: 4, config: defaultCoachingConfig() };
  const original = selection('MED_30');
  const updated = defaultCoachingV2Config();
  updated.offers[0].amountPaise = 510000;
  const saved = await configApi.saveCoachingConfig(updated, 4, 91);
  assert.equal(saved.version, 5);
  assert.equal(saved.config.schemaVersion, 2);
  assert.equal(history[0].config.offers[0].amountPaise, 510000);
  await assert.rejects(api.createCoachingOrder(userId, 'MED_30', { ...original, statedCondition: 'diabetes' }), { status: 409 });
  await assert.rejects(checkout('WELL_TRAINER_GYM', {}, 'Mumbai'), { status: 409 });
  await assert.rejects(configApi.saveCoachingConfig(updated, 4, 91), { status: 409 });
  const legacy = defaultCoachingConfig();
  legacy.regions.GURUGRAM.plans[0].amountPaise = 550000;
  await configApi.saveCoachingConfig(legacy, 5, 91);
  assert.equal(coachingCatalog('Gurugram', config.config).plans[0].amountPaise, 550000);
  assert.equal((await quote('MED_30', { statedCondition: 'diabetes' })).amountPaise, 510000);
  assert.equal(providerOrders.length, 0);
});

test('legacy keys still purchase and remain visible with v2 available', async () => {
  const legacy = coachingCatalog('Gurugram');
  for (const offer of [...legacy.plans, legacy.addon]) {
    if (offer === legacy.plans[1]) member.planEndsAt = new Date(0);
    const order = await api.createCoachingOrder(userId, offer.product, { city: 'Gurugram', offerId: offer.offerId });
    await settle(order);
    assert.equal(order.product, offer.product);
  }
  const view = await api.membershipView(userId);
  assert.equal(view.plan_type, 'QUARTERLY_11999');
  assert.equal(view.trainer_addon.product, 'TRAINER_ADDON_1499');
  assert.equal(view.addon_trainer_sessions_remaining, 4);
});

test('renewal starts at the old end and never restarts an active plan early', async t => {
  const start = new Date('2026-11-26T09:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  await buy('WELL_TRAINER_WEEKLY');
  const end = member.planEndsAt;
  const oldOrder = member.activeOrderId;
  await api.consumeSession(userId, 'TRAINER_SESSION', 91, 'trainer-0001');
  t.mock.timers.setTime(+end - 7 * day - 1);
  await assert.rejects(checkout('WELL_TRAINER_BIWEEKLY'), { status: 409 });
  t.mock.timers.setTime(+end - 7 * day);
  const renewal = await checkout('WELL_TRAINER_BIWEEKLY');
  assert.equal(renewal.isRenewal, true);
  assert.deepEqual(renewal.termStartsAt, end);
  await Promise.all([settle(renewal), settle(renewal)]);
  assert.equal(member.activeOrderId, oldOrder);
  assert.equal(member.trainerSessionsRemaining, 3);
  assert.equal(records.filter(row => row.kind === 'ONBOARDING').length, 1);
  assert.equal((await api.membershipView(userId)).scheduled_renewal.orderId, renewal.orderId);
  await assert.rejects(checkout('WELL_GYM'), { status: 409 });
  t.mock.timers.setTime(+end);
  const [, view] = await Promise.all([api.activateDueCoachingRenewals(), api.membershipView(userId)]);
  assert.equal(view.plan_type, 'WELL_TRAINER_BIWEEKLY');
  assert.equal(view.trainer_sessions_remaining, 8);
  assert.equal(+view.plan_ends_at, +end + 30 * day);
  assert.equal(view.scheduled_renewal, null);
  assert.equal(records.filter(row => row.kind === 'ONBOARDING').length, 2);
  t.mock.timers.setTime(+view.plan_ends_at + day);
  const late = await checkout('WELL_GYM');
  assert.equal(late.isRenewal, true);
  await settle(late);
  assert.equal(+member.planEndsAt, Date.now() + 30 * day);
});

test('wellness refund directs to support and a medical renewal refund preserves the current term', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T09:00:00Z') });
  await buy('WELL_GYM');
  await assert.rejects(api.requestCoachingRefund(userId), { status: 409, message: /contact support/ });
  t.mock.timers.setTime(+member.planEndsAt - 2 * day);
  const medical = await buy('MED_30', { statedCondition: 'diabetes' });
  await api.requestCoachingRefund(userId, medical.orderId);
  await api.requestCoachingRefund(userId, medical.orderId);
  assert.equal(refunds.length, 1);
  assert.equal(member.planType, 'WELL_GYM');
  assert.equal(member.planStatus, 'ACTIVE');
  assert.equal(member.scheduledOrderId, null);
});

test('the medical guarantee ends 72 hours after payment, including on scheduled renewals', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T09:00:00Z') });
  await buy('WELL_GYM');
  t.mock.timers.setTime(+member.planEndsAt - 6 * day);
  const renewal = await buy('MED_30', { statedCondition: 'diabetes' });
  t.mock.timers.setTime(Date.now() + 3 * day + 1);
  await assert.rejects(api.requestCoachingRefund(userId, renewal.orderId), { status: 400, message: /72-hour/ });
  assert.equal(refunds.length, 0);
});

test('delayed capture of an add-on for an expired term refunds the payment and leaves new balances alone', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T09:00:00Z') });
  await buy('WELL_TRAINER_WEEKLY');
  const addon = await checkout('ADDON_TRAINER', { quantity: 4 });
  t.mock.timers.setTime(+member.planEndsAt - day);
  const renewal = await buy('WELL_TRAINER_BIWEEKLY');
  t.mock.timers.setTime(+renewal.termStartsAt);
  await settle(addon);
  assert.equal(member.planType, 'WELL_TRAINER_BIWEEKLY');
  assert.equal(member.trainerSessionsRemaining, 8);
  assert.equal(orders.find(order => order.orderId === addon.orderId).status, 'REFUNDED');
  assert.equal(refunds.length, 1);
  assert.ok(!events.some(([name]) => name === 'addon_purchased'));
});

test('medical RED clearance blocks trainer and gym access while allowing nutritionist sessions', async () => {
  await buy('MED_30', { statedCondition: 'diabetes' });
  await buy('ADDON_NUTRITIONIST');
  context.riskBucket = 'RED';
  await assert.rejects(api.consumeSession(userId, 'TRAINER_SESSION', 91, 'trainer-0001'), { status: 409 });
  assert.equal((await api.membershipView(userId)).clearanceRequired, true);
  assert.equal(await api.coachingGymEntitlement(userId), null);
  await api.consumeSession(userId, 'NUTRITIONIST_SESSION', 91, 'nutrition-0001');
  context.clinicalStatus = 'CLEARED';
  await api.consumeSession(userId, 'TRAINER_SESSION', 91, 'trainer-0001');
  assert.equal(member.trainerSessionsRemaining, 3);
});

test('v2 events use the required props once and synchronous and asynchronous tracking failures are harmless', async t => {
  const start = new Date('2026-11-26T09:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  trackingFailure = 'sync';
  const details = { statedCondition: 'prediabetes', couponCode: 'save10' };
  await quote('MED_30', details);
  const plan = await buy('MED_30', details);
  assert.equal(Object.hasOwn(member.offerSnapshot, 'statedCondition'), false);
  await settle(plan);
  trackingFailure = 'async';
  await quote('ADDON_TRAINER', { quantity: 4 });
  await buy('ADDON_TRAINER', { quantity: 4 });
  t.mock.timers.setTime(+start + 2 * 3600000);
  await Promise.all([api.requestCoachingRefund(userId), api.requestCoachingRefund(userId)]);
  assert.equal(member.planStatus, 'REFUNDED');
  assert.equal(member.trainerSessionsRemaining, 0);
  assert.equal(refunds.length, 1);
  assert.deepEqual(events, [
    ['offer_quote_created', userId, { offer_key: 'MED_30', region: 'GURUGRAM', amount_paise: 450000, coupon_code: 'SAVE10', addon_count: 0 }],
    ['offer_purchased', userId, { offer_key: 'MED_30', family: 'medical', region: 'GURUGRAM', amount_paise: 450000, coupon_code: 'SAVE10', is_renewal: false }],
    ['offer_quote_created', userId, { offer_key: 'ADDON_TRAINER', region: 'GURUGRAM', amount_paise: 180000, coupon_code: null, addon_count: 4 }],
    ['addon_purchased', userId, { addon_key: 'ADDON_TRAINER', quantity: 4, discount_pct: 10 }],
    ['offer_refund_requested', userId, { offer_key: 'MED_30', family: 'medical', hours_since_purchase: 2 }],
  ]);
});
