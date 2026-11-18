import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let service, order, membership, grants, payment, captureCalls, fulfillments;
const update = (target, data) => { for (const [k, v] of Object.entries(data)) target[k] = v && typeof v === 'object' && 'decrement' in v ? target[k] - v.decrement : v; return target; };
before(async t => {
  const db = {
    $queryRaw: async () => [],
    coachingOrder: { findUnique: async ({ where }) => where.orderId && where.orderId !== order.orderId ? null : { ...order }, update: async ({ data }) => update(order, data) },
    coachingMembership: { findUnique: async () => membership && { ...membership }, upsert: async ({ create, update: data }) => membership = membership ? update(membership, data) : { ...create } },
    coachingAddonGrant: { create: async ({ data }) => { grants.push(data); return data; } },
    coachingFulfillment: { create: async ({ data }) => { fulfillments.push(data); return data; } },
  };
  let queue = Promise.resolve();
  db.$transaction = fn => { const next = queue.then(() => fn(db)); queue = next.catch(() => {}); return next; };
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: { data: { dateOfBirth: '1995-01-01' } } }) } } });
  t.mock.module('razorpay', { exports: { default: class { constructor() { this.payments = { fetch: async () => ({ ...payment }), capture: async () => { captureCalls++; payment.status = 'captured'; return { ...payment }; } }; } } } });
  service = await import('../services/coachingService.js');
});
function reset(product = 'QUARTERLY_11999') {
  order = { id: 1, userId: 4, orderId: 'order_test', product, status: 'PENDING', amountPaise: service.COACHING_PRODUCTS[product] };
  membership = null; grants = []; fulfillments = []; captureCalls = 0;
  payment = { id: 'pay_test', order_id: 'order_test', amount: order.amountPaise, currency: 'INR', status: 'captured' };
}
test('concurrent callbacks and webhook delivery grant one membership and one onboarding task', async () => {
  reset();
  await Promise.all([service.settleCoachingPayment('order_test', 'pay_test'), service.settleCoachingPayment('order_test', 'pay_test')]);
  assert.equal(order.status, 'SUCCESS'); assert.equal(membership.planType, 'QUARTERLY_11999');
  assert.equal(membership.freeDelightSessionsRemaining, 2); assert.equal(membership.labCreditsRemaining, 2);
  assert.equal(+membership.trialEndsAt - +membership.purchasedAt, 72 * 3600000);
  assert.equal(fulfillments.length, 1);
});
test('authorized payment is captured, while mismatched captured payments never grant access', async () => {
  reset();payment.status = 'authorized';await service.settleCoachingPayment('order_test', 'pay_test');assert.equal(captureCalls, 1);
  for (const values of [{ amount: 1 }, { currency: 'USD' }, { order_id: 'other' }]) {
    reset();Object.assign(payment, values);await assert.rejects(service.settleCoachingPayment('order_test', 'pay_test'));assert.equal(membership, null);assert.equal(order.status, 'PENDING');
  }
});
test('add-on replay creates one four-session grant with a thirty-day expiry', async () => {
  reset('TRAINER_ADDON_1499');membership = { userId: 4, planType: 'MONTHLY_4499', planStatus: 'ACTIVE', planEndsAt: new Date(Date.now() + 86400000) };
  await service.settleCoachingPayment('order_test', 'pay_test');await service.settleCoachingPayment('order_test', 'pay_test');
  assert.equal(grants.length, 1);assert.equal(grants[0].remaining, 4);assert.ok(grants[0].expiresAt > new Date(Date.now() + 29 * 86400000));
});
test('expiry and refund statuses never grant coaching; payment signatures are exact', () => {
  const row = { planType: 'QUARTERLY_11999', planStatus: 'ACTIVE', planEndsAt: new Date(Date.now() + 1000) };
  assert.equal(service.hasGuidance(row), true);
  assert.equal(service.hasGuidance({ ...row, planEndsAt: new Date(0) }), false);
  assert.equal(service.hasGuidance({ ...row, planStatus: 'REFUNDED' }), false);
  process.env.RAZORPAY_SECRET = 'unit-test-secret';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET).update('order_a|pay_a').digest('hex');
  assert.equal(service.signatureMatches('order_a', 'pay_a', signature), true);
  assert.equal(service.signatureMatches('order_a', 'pay_b', signature), false);
  assert.equal(service.signatureMatches('order_a', 'pay_a', 'bad'), false);
});
