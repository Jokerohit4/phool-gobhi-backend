import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { coachingCatalog, coachingCatalogV2 } from '../services/coachingCatalog.js';
import { defaultCoachingConfig } from '../services/coachingDefaults.js';
import { defaultCoachingV2Config } from '../services/coachingV2Config.js';
import { importCoachingCoupons } from '../scripts/importCoachingCoupons.js';

const userId = 7;
const day = 86400000;
let api, configApi, router, extractUser, account, context, config, history, member, orders, grants, records, events, providerOrders, refunds, trackingFailure;
let coupons, redemptions, locks, failedPayments, beforeProviderOrder, db;
let bookingRequests, bookingUnavailable;

const copy = value => structuredClone(value ?? null);
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'NOT') return !matches(row, value);
    if (key === 'order') return matches(orders.find(order => order.orderId === row.orderId), value);
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
  const orderView = (order, include) => copy(order && include?.couponRedemption
    ? { ...order, couponRedemption: redemptions.find(row => row.orderId === order.orderId) }
    : order);
  const saveCoupon = data => {
    const row = { id: coupons.length + 1, enabled: true, updatedAt: new Date(), ...data, offerKeys: data.offerKeys ?? null };
    if (!Array.isArray(row.offerKeys)) row.offerKeys = null;
    coupons.push(row);
    return copy(row);
  };
  db = {
    $transaction: async fn => {
      if (Array.isArray(fn)) return Promise.all(fn);
      const release = [];
      const tx = { ...db, $queryRaw: async (sql, id) => {
        const isCoupon = sql.join('').includes('FOR UPDATE');
        const key = isCoupon ? `coupon:${id}` : `user:${id}`;
        const previous = locks.get(key);
        locks.set(key, new Promise(resolve => release.push(resolve)));
        await previous;
        return isCoupon ? coupons.filter(row => row.code === id) : [];
      } };
      try { return await fn(tx); }
      finally { for (const unlock of release) unlock(); }
    },
    coupon: {
      findUnique: async ({ where }) => copy(coupons.find(row => matches(row, where))),
      findMany: async () => copy(coupons),
      create: async ({ data }) => saveCoupon(data),
      update: async ({ where, data }) => update(coupons.find(row => matches(row, where)), {
        ...data, offerKeys: Array.isArray(data.offerKeys) ? data.offerKeys : null,
      }),
      upsert: async ({ where, create }) => copy(coupons.find(row => matches(row, where)) ?? saveCoupon(create)),
    },
    couponRedemption: {
      create: async ({ data }) => redemptions.push({ ...data, status: 'reserved' }),
      count: async ({ where }) => redemptions.filter(row => matches(row, where)).length,
      findUnique: async ({ where }) => copy(redemptions.find(row => matches(row, where))),
      update: async ({ where, data }) => update(redemptions.find(row => matches(row, where)), data),
      updateMany: async ({ where, data }) => {
        const rows = redemptions.filter(row => matches(row, where));
        for (const row of rows) update(row, data);
        return { count: rows.length };
      },
      groupBy: async () => {
        const groups = new Map();
        for (const { couponId, status } of redemptions) {
          const key = `${couponId}:${status}`;
          if (!groups.has(key)) groups.set(key, { couponId, status, _count: { _all: 0 } });
          groups.get(key)._count._all++;
        }
        return [...groups.values()];
      },
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
      findFirst: async ({ where, include }) => orderView(orders.find(row => matches(row, where)), include),
      findMany: async ({ where, include }) => orders.filter(row => matches(row, where)).map(row => orderView(row, include)),
      create: async ({ data }) => {
        const row = { id: orders.length + 1, status: 'PENDING', createdAt: new Date(), ...copy(data) };
        orders.push(row);
        return copy(row);
      },
      update: async ({ where, data }) => update(orders.find(row => matches(row, where)), data),
      updateManyAndReturn: async ({ where, data }) => orders.filter(row => matches(row, where)).map(row => update(row, data)),
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
      findMany: async ({ where }) => copy(records.filter(row => matches(row, where))),
      create: async ({ data }) => {
        const row = { id: records.length + 1, status: 'REQUESTED', ...copy(data) };
        records.push(row);
        return copy(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = records.filter(row => matches(row, where));
        for (const row of rows) update(row, data);
        return { count: rows.length };
      },
    },
  };
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: {
    get: async url => {
      if (url.includes('/internal/entitlements/')) {
        const addonRemaining = bookingRequests.filter(row => row.path.endsWith('/addon-balance') && row.delivered)
          .reduce((total, row) => total + row.body.sessions, 0);
        return { data: { data: { addonRemaining } } };
      }
      return { data: { data: url.includes('/guidance/internal/') ? context : account } };
    },
    post: async (url, body) => {
      bookingRequests.push({ path: new URL(url).pathname, body: copy(body), delivered: !bookingUnavailable });
      if (bookingUnavailable) throw new Error('booking service unavailable');
      return { data: { data: {} } };
    },
  } } });
  t.mock.module('../utils/analytics.js', { exports: { track: (...args) => {
    events.push(args);
    if (trackingFailure === 'sync') throw new Error('analytics down');
    if (trackingFailure === 'async') return Promise.reject(new Error('analytics down'));
  } } });
  t.mock.module('razorpay', { exports: { default: class {
    orders = { create: async payload => {
      await beforeProviderOrder();
      const order = { ...payload, id: `order_${providerOrders.length + 1}` };
      providerOrders.push(order);
      return order;
    }, fetchPayments: async id => ({ items: failedPayments.has(id) ? [{ status: 'failed' }] : [] }) };
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

beforeEach(() => {
  account = { dateOfBirth: '1995-01-01', isActive: true, name: 'Private Name', phone: '1234567890' };
  context = { hasUploadedReport: false, confirmedDetails: { name: 'Private Name' } };
  config = member = trackingFailure = null;
  orders = []; grants = []; records = []; events = []; providerOrders = []; refunds = []; history = [];
  bookingRequests = [];
  bookingUnavailable = false;
  locks = new Map();
  failedPayments = new Set();
  beforeProviderOrder = async () => {};
  coupons = [{ id: 1, code: 'SAVE10', kind: 'percent', value: 10, enabled: true, offerKeys: ['ADDON_TRAINER', 'MED_30'] }];
  redemptions = [];
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

test('add-ons need a matching active family and region, keep trainer tiers and reject coupons', async () => {
  await assert.rejects(quote('ADDON_TRAINER', { quantity: 4 }), { status: 403 });
  await assert.rejects(checkout('ADDON_TRAINER', { quantity: 4 }), { status: 403 });
  await buy('MED_30', { statedCondition: 'diabetes' });
  assert.equal((await quote('ADDON_TRAINER', { quantity: 3 })).amountPaise, 150000);
  assert.equal((await quote('ADDON_TRAINER', { quantity: 4 })).amountPaise, 180000);
  const discounted = await quote('ADDON_TRAINER', { quantity: 4 });
  assert.deepEqual(discounted.lines, [
    { type: 'list_price', key: 'ADDON_TRAINER', quantity: 4, unitPaise: 50000, amountPaise: 200000 },
    { type: 'volume_discount', discountPct: 10, amountPaise: -20000 },
    { type: 'total', amountPaise: 180000 },
  ]);
  await assert.rejects(quote('ADDON_TRAINER', { quantity: 4, couponCode: ' save10 ' }), { status: 400, couponReason: 'not_eligible' });
  await assert.rejects(checkout('ADDON_TRAINER', { quantity: 4, couponCode: ' save10 ' }), { status: 400, couponReason: 'not_eligible' });
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
  const gymAddon = await buy('ADDON_GYM', { quantity: 2 });
  assert.deepEqual(bookingRequests.find(row => row.path.endsWith('/addon-balance')).body, {
    customerId: userId, termOrderRef: `coaching-term-${member.activeOrderId}`,
    sessions: 2, expiresAt: member.planEndsAt.toISOString(),
    idempotencyKey: `coaching-gym-addon-${orders.find(row => row.orderId === gymAddon.orderId).id}`,
  });
  assert.equal((await api.membershipView(userId)).gym_sessions_remaining, 2);
  assert.equal(member.gymSessionsRemaining, undefined);
  member.planEndsAt = new Date(0);
  await buy('WELL_TRAINER_GYM_NUTRI');
  assert.equal(member.nutritionistSessionsRemaining, 2);
  assert.equal(member.gymSessionsRemaining, undefined);
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

test('medical RED clearance blocks trainer sessions and flags the gym entitlement for booking', async () => {
  await buy('MED_30', { statedCondition: 'diabetes' });
  await buy('ADDON_NUTRITIONIST');
  context.riskBucket = 'RED';
  await assert.rejects(api.consumeSession(userId, 'TRAINER_SESSION', 91, 'trainer-0001'), { status: 409 });
  assert.equal((await api.membershipView(userId)).clearanceRequired, true);
  assert.equal(bookingRequests.find(row => row.path === '/internal/entitlements').body.requiresClearance, true);
  assert.equal((await api.membershipView(userId)).fulfillment.some(row => row.kind === api.GYM_ENTITLEMENT_SYNC), false);
  await api.consumeSession(userId, 'NUTRITIONIST_SESSION', 91, 'nutrition-0001');
  context.clinicalStatus = 'CLEARED';
  assert.equal((await api.membershipView(userId)).clearanceRequired, false);
  await api.consumeSession(userId, 'TRAINER_SESSION', 91, 'trainer-0001');
  assert.equal(member.trainerSessionsRemaining, 3);
});

test('booking-service failure leaves the payment successful and internal reconcile retries fulfillment', async t => {
  const originalKey = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = 'test-reconcile-key';
  t.after(() => {
    if (originalKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = originalKey;
  });
  bookingUnavailable = true;
  const order = await buy('WELL_GYM');
  assert.equal(orders.find(row => row.orderId === order.orderId).status, 'SUCCESS');
  const fulfillment = records.find(row => row.kind === api.GYM_ENTITLEMENT_SYNC);
  assert.equal(fulfillment.status, 'PENDING');

  bookingUnavailable = false;
  const app = express();
  app.use(express.json(), router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/internal/reconcile`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    const response = await fetch(url, { method: 'POST', headers: { 'x-internal-key': 'test-reconcile-key' } });
    assert.equal(response.status, 200);
    assert.equal(fulfillment.status, 'COMPLETED');
    assert.deepEqual(bookingRequests.map(row => row.delivered), [false, true]);
    assert.deepEqual(bookingRequests[0].body, bookingRequests[1].body);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('scheduled gym renewal activates only when due and a refunded term queues cancellation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T09:00:00Z') });
  await buy('WELL_GYM');
  const termEnd = member.planEndsAt;
  t.mock.timers.setTime(+termEnd - day);
  const renewal = await buy('MED_30', { statedCondition: 'diabetes' });
  assert.equal(bookingRequests.length, 1);
  t.mock.timers.setTime(+termEnd);
  await api.activateDueCoachingRenewals();
  const [activation, nextActivation] = bookingRequests;
  assert.equal(activation.body.source, 'purchase');
  assert.equal(nextActivation.body.source, 'renewal');
  assert.equal(nextActivation.body.startsAt, termEnd.toISOString());
  assert.equal(nextActivation.body.requiresClearance, true);

  bookingUnavailable = true;
  await api.requestCoachingRefund(userId, renewal.orderId);
  assert.equal(orders.find(row => row.orderId === renewal.orderId).status, 'REFUNDED');
  const cancel = records.find(row => row.details?.action === 'cancel');
  assert.equal(cancel.status, 'PENDING');
  bookingUnavailable = false;
  await api.retryGymFulfillment();
  assert.equal(cancel.status, 'COMPLETED');
  assert.deepEqual(bookingRequests.at(-1), {
    path: '/internal/entitlements/cancel', body: { orderRef: nextActivation.body.orderRef }, delivered: true,
  });
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
    ['coupon_applied', userId, { coupon_code: 'SAVE10', reason: 'applied' }],
    ['offer_purchased', userId, { offer_key: 'MED_30', family: 'medical', region: 'GURUGRAM', amount_paise: 450000, coupon_code: 'SAVE10', is_renewal: false }],
    ['offer_quote_created', userId, { offer_key: 'ADDON_TRAINER', region: 'GURUGRAM', amount_paise: 180000, coupon_code: null, addon_count: 4 }],
    ['addon_purchased', userId, { addon_key: 'ADDON_TRAINER', quantity: 4, discount_pct: 10 }],
    ['offer_refund_requested', userId, { offer_key: 'MED_30', family: 'medical', hours_since_purchase: 2 }],
  ]);
});

const medicalCoupon = { statedCondition: 'diabetes', couponCode: 'SAVE10' };

test('concurrent customers compete for the last coupon slots under the coupon lock', async () => {
  coupons[0].maxRedemptions = 2;
  const results = await Promise.allSettled([7, 8, 9, 10, 11].map(id =>
    api.createCoachingOrder(id, 'MED_30', selection('MED_30', 'Gurugram', medicalCoupon))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 3);
  for (const { reason } of rejected) assert.equal(reason.couponReason, 'limit_reached');
  assert.equal(redemptions.filter(row => row.status === 'reserved').length, 2);
  assert.equal(orders.length, 2);
  assert.equal(providerOrders.length, 5);
  assert.equal(events.filter(([event]) => event === 'coupon_applied').length, 2);
});

test('pending checkout can be reused, while a redeemed coupon counts toward the customer limit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T09:00:00Z') });
  coupons[0].perCustomerLimit = 1;
  const order = await checkout('MED_30', medicalCoupon);
  assert.equal((await quote('MED_30', medicalCoupon)).couponCode, 'SAVE10');
  assert.equal((await checkout('MED_30', medicalCoupon)).orderId, order.orderId);
  assert.equal(redemptions.length, 1);
  await Promise.all([settle(order), settle(order)]);
  assert.equal(redemptions[0].status, 'redeemed');
  t.mock.timers.setTime(+member.planEndsAt - day);
  await assert.rejects(quote('MED_30', medicalCoupon), { couponReason: 'limit_reached' });
  await assert.rejects(checkout('MED_30', medicalCoupon), { couponReason: 'limit_reached' });
  assert.equal(orders.length, 1);
});

test('dates, eligibility, invalid codes and disabled coupons reject with coded telemetry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T09:00:00Z') });
  trackingFailure = 'sync';
  const outcome = { status: 400, message: 'This coupon is invalid or unavailable for this plan.' };
  coupons[0].activeFrom = new Date(Date.now() + 1);
  await assert.rejects(quote('MED_30', medicalCoupon), { ...outcome, couponReason: 'expired' });
  coupons[0].activeFrom = new Date(Date.now());
  coupons[0].activeTo = new Date(Date.now() + 1);
  assert.equal((await quote('MED_30', medicalCoupon)).amountPaise, 450000);
  t.mock.timers.setTime(+coupons[0].activeTo);
  await assert.rejects(checkout('MED_30', medicalCoupon), { ...outcome, couponReason: 'expired' });
  coupons[0].activeTo = null;
  trackingFailure = 'async';
  await assert.rejects(quote('WELL_GYM', medicalCoupon), { ...outcome, couponReason: 'not_eligible' });
  await assert.rejects(quote('MED_30', { ...medicalCoupon, couponCode: 'UNKNOWN' }), { ...outcome, couponReason: 'invalid' });
  coupons[0].enabled = false;
  await assert.rejects(quote('MED_30', medicalCoupon), { ...outcome, couponReason: 'disabled' });
  assert.deepEqual(events.filter(([event]) => event === 'coupon_rejected').map(([, , props]) => props), [
    { coupon_code: 'SAVE10', reason: 'expired' },
    { coupon_code: 'SAVE10', reason: 'expired' },
    { coupon_code: 'SAVE10', reason: 'not_eligible' },
    { coupon_code: 'UNKNOWN', reason: 'invalid' },
    { coupon_code: 'SAVE10', reason: 'disabled' },
  ]);
});

test('fixed discounts leave at least 100 paise in the quote and provider order', async () => {
  Object.assign(coupons[0], { kind: 'fixed', value: 999999, offerKeys: null });
  const quoted = await quote('MED_30', medicalCoupon);
  assert.equal(quoted.couponDiscountPaise, 499900);
  assert.equal(quoted.amountPaise, 100);
  const order = await checkout('MED_30', { ...medicalCoupon, expectedAmountPaise: 100 });
  assert.equal(order.amountPaise, 100);
  assert.equal(providerOrders[0].amount, 100);
});

test('checkout revalidates the coupon after requesting the provider order', async () => {
  beforeProviderOrder = async () => { coupons[0].value = 20; };
  await assert.rejects(checkout('MED_30', medicalCoupon), {
    status: 409, message: 'The checkout price changed. Review the total and try again.',
  });
  assert.equal(orders.length, 0);
  assert.equal(redemptions.length, 0);
  assert.equal(events.length, 0);
});

test('replacement and reconciliation release reservations, and a late capture cannot exceed the limit', async () => {
  Object.assign(coupons[0], { maxRedemptions: 1, offerKeys: null });
  const first = await checkout('MED_30', medicalCoupon);
  const replacement = await checkout('WELL_GYM', medicalCoupon);
  assert.equal(orders[0].status, 'CANCELLED');
  assert.deepEqual(redemptions.map(row => row.status), ['released', 'reserved']);
  await settle(first);
  assert.equal(orders[0].status, 'REFUNDED');
  failedPayments.add(replacement.orderId);
  await api.reconcileCoaching(userId);
  await api.markCoachingPaymentFailed(replacement.orderId);
  assert.equal(orders[1].status, 'FAILED');
  assert.equal(redemptions[1].status, 'released');
  await api.createCoachingOrder(8, 'MED_30', selection('MED_30', 'Gurugram', medicalCoupon));
  await settle(replacement);
  assert.equal(orders[1].status, 'REFUNDED');
  assert.deepEqual(redemptions.map(row => row.status), ['released', 'released', 'reserved']);
});

test('a later successful payment on a failed order redeems the coupon if a slot remains', async () => {
  coupons[0].maxRedemptions = 1;
  const order = await checkout('MED_30', medicalCoupon);
  await api.markCoachingPaymentFailed(order.orderId);
  await settle(order);
  await api.markCoachingPaymentFailed(order.orderId);
  assert.equal(orders[0].status, 'SUCCESS');
  assert.equal(redemptions[0].status, 'redeemed');
});

test('reconciliation cancels an abandoned coupon checkout after 24 hours', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-26T09:00:00Z') });
  const order = await checkout('MED_30', medicalCoupon);
  t.mock.timers.setTime(Date.now() + day - 1);
  await api.reconcileCoaching(userId);
  assert.equal((await checkout('MED_30', medicalCoupon)).orderId, order.orderId);
  t.mock.timers.setTime(Date.now() + 1);
  await api.reconcileCoaching(userId);
  assert.equal(orders[0].status, 'CANCELLED');
  assert.equal(redemptions[0].status, 'released');
});

test('gobhi admins can create, list and disable coupons with timestamp conflict handling', async () => {
  const app = express();
  app.use(express.json(), extractUser, router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/coupons`;
  const request = (method, path = '', body, role = 'gobhi', actor = 91) => fetch(url + path, {
    method, headers: { 'x-user-role': role, 'x-user-id': String(actor), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await request('GET', '', undefined, 'customer')).status, 403);
    const initial = { code: 'owner-15', kind: 'percent', value: 15 };
    assert.equal((await request('POST', '', { ...initial, value: 100 })).status, 400);
    const created = await request('POST', '', initial);
    assert.equal(created.status, 200);
    const { data: coupon } = await created.json();
    assert.equal(coupon.code, 'OWNER-15');
    assert.equal(coupon.updatedBy, 91);
    await checkout('MED_30', { ...medicalCoupon, couponCode: coupon.code });
    const { data: listed } = await (await request('GET')).json();
    assert.deepEqual(listed.find(row => row.code === coupon.code).redemptionCounts, { reserved: 1, redeemed: 0, released: 0 });
    const [disable, conflict] = await Promise.all([
      request('PATCH', '/OWNER-15', { expectedUpdatedAt: coupon.updatedAt, enabled: false }, 'gobhi', 92),
      request('PATCH', '/OWNER-15', { expectedUpdatedAt: coupon.updatedAt, enabled: false }, 'gobhi', 92),
    ]).then(responses => responses.sort((a, b) => a.status - b.status));
    const { data: disabled } = await disable.json();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.updatedBy, 92);
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.errorCode, 'CONFIG_CONFLICT');
    assert.equal(body.currentUpdatedAt, disabled.updatedAt);
    await assert.rejects(quote('MED_30', { ...medicalCoupon, couponCode: coupon.code }), { couponReason: 'disabled' });
    assert.equal(redemptions[0].status, 'reserved');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('legacy coupon import is idempotent and preserves owner edits', async () => {
  const raw = JSON.stringify({
    LEGACY: { percentOff: 25, products: ['MONTHLY_4499'], expiresAt: '2030-01-01T00:00:00Z' },
    INVALID: { percentOff: 100 },
    ALL: { percentOff: 5 },
  });
  assert.deepEqual(await importCoachingCoupons(db, raw), { processed: 2, skipped: 1 });
  const legacy = coupons.find(row => row.code === 'LEGACY');
  assert.deepEqual(legacy.offerKeys, ['MONTHLY_4499']);
  assert.equal(legacy.activeTo.toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(coupons.find(row => row.code === 'ALL').offerKeys, null);
  legacy.enabled = false;
  const snapshot = copy(coupons);
  await importCoachingCoupons(db, raw);
  assert.deepEqual(coupons, snapshot);
});
