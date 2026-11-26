import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { coachingCatalog } from '../services/coachingCatalog.js';

let service, member, orders, providerOrders, coupons;
before(async t => {
  const db = {
    coachingCatalogConfig: { findUnique: async () => null },
    $queryRaw: async (sql, key) => sql.join('').includes('FOR UPDATE') && coupons[key] ? [coupons[key]] : [],
    coupon: { findUnique: async ({ where }) => coupons[where.code] },
    couponRedemption: { create: async () => {}, updateMany: async () => ({ count: 0 }) },
    coachingMembership: { updateMany: async () => ({ count: 0 }), findUnique: async () => member },
    coachingOrder: {
      findFirst: async ({ where }) => orders.find(o => o.userId === where.userId && o.product === where.product && o.status === where.status),
      update: async ({ where, data }) => Object.assign(orders.find(o => o.id === where.id), data),
      updateManyAndReturn: async ({ where, data }) => orders
        .filter(order => order.userId === where.userId && order.status === where.status && !order.isAddon)
        .map(order => Object.assign(order, data)),
      create: async ({ data }) => { const order = { id: orders.length + 1, status: 'PENDING', ...data }; orders.push(order); return order; },
    },
  };
  db.$transaction = fn => fn(db);
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: { data: { dateOfBirth: '1995-01-01' } } }) } } });
  t.mock.module('razorpay', { exports: { default: class {
    constructor() { this.orders = { create: async payload => { providerOrders.push(payload); return { id: `order_${providerOrders.length}` }; } }; }
  } } });
  service = await import('../services/coachingService.js');
});
const original = process.env.COACHING_REMOTE_MONTHLY_PRICE_PAISE;
afterEach(() => { if (original === undefined) delete process.env.COACHING_REMOTE_MONTHLY_PRICE_PAISE; else process.env.COACHING_REMOTE_MONTHLY_PRICE_PAISE = original; });
function reset() { member = null; orders = []; providerOrders = []; coupons = {}; }

test('unselected city, unavailable remote pricing and stale quotes cannot create a provider order', async () => {
  reset();delete process.env.COACHING_REMOTE_MONTHLY_PRICE_PAISE;
  await assert.rejects(service.createCoachingOrder(7, 'MONTHLY_4499'), { status: 400 });
  await assert.rejects(service.createCoachingOrder(7, 'MONTHLY_4499', { city: 'Mumbai', offerId: 'invented' }), { status: 409 });
  const offer = coachingCatalog('Gurugram').plans[0];
  await assert.rejects(service.createCoachingOrder(7, 'MONTHLY_4499', { city: 'Gurugram', offerId: offer.offerId + 'tampered' }), { status: 409 });
  assert.equal(providerOrders.length, 0);
});
test('switching regions replaces the pending order and snapshots the server price', async () => {
  reset();
  const local = coachingCatalog('Gurugram').plans[0];
  const first = await service.createCoachingOrder(7, local.product, { city: 'Gurugram', offerId: local.offerId });
  assert.equal(providerOrders[0].amount, 449900);
  process.env.COACHING_REMOTE_MONTHLY_PRICE_PAISE = '123400';
  const remote = coachingCatalog('Mumbai').plans[0];
  const second = await service.createCoachingOrder(7, remote.product, { city: 'Mumbai', offerId: remote.offerId, amountPaise: 1 });
  assert.notEqual(first.orderId, second.orderId);
  assert.equal(orders[0].status, 'CANCELLED');
  assert.equal(providerOrders[1].amount, 123400);
  assert.equal(orders[1].offerSnapshot.region, 'REST_INDIA');
  assert.equal(orders[1].offerSnapshot.benefits.gymAccess, false);
  await service.createCoachingOrder(7, remote.product, { city: 'Mumbai', offerId: remote.offerId });
  assert.equal(providerOrders.length, 2);
});
test('trainer checkout cannot be used by a guidance-only member', async () => {
  reset();member = { planType: 'MONTHLY_4499', planStatus: 'ACTIVE', planEndsAt: new Date(Date.now() + 86400000), offerSnapshot: { region: 'REST_INDIA' } };
  await assert.rejects(service.createCoachingOrder(7, 'TRAINER_ADDON_1499'), { status: 403 });
  assert.equal(providerOrders.length, 0);
});

test('coupon quotes revalidate on checkout and reuse only matching orders', async () => {
  reset();
  const offer = coachingCatalog('Gurugram').plans[0];
  coupons = {
    SAVE10: { id: 1, code: 'SAVE10', enabled: true, kind: 'percent', value: 10, offerKeys: [offer.product] },
    EXPIRED: { id: 2, code: 'EXPIRED', enabled: true, kind: 'percent', value: 25, activeTo: new Date('2020-01-01T00:00:00Z') },
  };
  const selection = { city: 'Gurugram', offerId: offer.offerId, couponCode: ' save10 ' };
  const quote = await service.quoteCoachingOrder(offer.product, selection);
  assert.deepEqual(quote, {
    originalAmountPaise: 449900, amountPaise: 404910, discountPaise: 44990, couponCode: 'SAVE10',
  });
  await assert.rejects(service.quoteCoachingOrder(offer.product, { ...selection, couponCode: 'EXPIRED' }), { status: 400 });
  await assert.rejects(service.createCoachingOrder(7, offer.product, { ...selection, expectedAmountPaise: 1 }), { status: 409 });
  assert.equal(providerOrders.length, 0);
  const order = await service.createCoachingOrder(7, offer.product, { ...selection, expectedAmountPaise: quote.amountPaise });
  assert.equal(providerOrders[0].amount, quote.amountPaise);
  assert.equal(orders[0].offerSnapshot.discount.couponCode, 'SAVE10');
  assert.equal((await service.createCoachingOrder(7, offer.product, selection)).orderId, order.orderId);
  const fullPrice = await service.createCoachingOrder(7, offer.product, { ...selection, couponCode: null });
  assert.notEqual(fullPrice.orderId, order.orderId);
  assert.equal(providerOrders[1].amount, quote.originalAmountPaise);
});
