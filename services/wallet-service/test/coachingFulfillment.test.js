import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let api, member, order, records, grants, context, refundCalls, refunds;
const day = 86400000;
const matches = (row, where) => Object.entries(where).every(([key, value]) => value && typeof value === 'object' && !(value instanceof Date) ? value.notIn ? !value.notIn.includes(row[key]) : value.in ? value.in.includes(row[key]) : value.gt ? row[key] > value.gt : true : row[key] === value);
const update = (row, data) => { for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'decrement' in v ? row[k] - v.decrement : v;row.updatedAt = new Date();return row; };
before(async t => {
  const db = {
    $queryRaw: async () => [],
    coachingMembership: { findUnique: async () => ({ ...member }), update: async ({ data }) => update(member, data), updateMany: async ({ where, data }) => { if (!matches(member, where)) return { count: 0 };update(member, data);return { count: 1 }; } },
    coachingFulfillment: { findUnique: async ({ where }) => records.find(r => r.idempotencyKey === where.idempotencyKey), findFirst: async () => records.find(r => r.kind === 'LAB' && ['REQUESTED', 'CONFIRMED'].includes(r.status)), create: async ({ data }) => { const row = { id: records.length + 1, status: 'REQUESTED', ...data };records.push(row);return row; } },
    coachingAddonGrant: { findFirst: async () => grants.find(g => g.remaining > 0 && g.expiresAt > new Date()), update: async ({ where, data }) => update(grants.find(g => g.id === where.id), data) },
    coachingOrder: { findUnique: async () => ({ ...order }), update: async ({ data }) => update(order, data), updateMany: async ({ where, data }) => { if (!matches(order, where)) return { count: 0 };update(order, data);return { count: 1 }; } },
  };
  let queue = Promise.resolve();db.$transaction = fn => { const result = queue.then(() => fn(db));queue = result.catch(() => {});return result; };
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { get: async url => ({ data: { data: url.includes('auth-service') ? { dateOfBirth: '1995-01-01', isActive: true } : context } }) } } });
  t.mock.module('razorpay', { exports: { default: class { constructor() { this.payments = { fetchMultipleRefund: async () => ({ items: refunds }), refund: async (_paymentId, data) => { refundCalls++;const row = { id: 'refund_1', receipt: data.receipt, status: 'processed' };refunds.push(row);return row; } }; } } } });
  api = await import('../services/coachingService.js');
});
function reset() {
  member = { userId: 7, activeOrderId: 1, planType: 'QUARTERLY_11999', planStatus: 'ACTIVE', purchasedAt: new Date(Date.now() - 3 * day), trialEndsAt: new Date(Date.now() - 1), planEndsAt: new Date(Date.now() + 87 * day), labCreditsRemaining: 2, freeDelightSessionsRemaining: 2 };
  order = { id: 1, userId: 7, status: 'SUCCESS', paymentId: 'pay_1', amountPaise: 1199900, refundRequestedAt: null, updatedAt: new Date() };
  records = [];grants = [];context = { riskBucket: 'GREEN', clinicalStatus: 'PENDING' };refundCalls = 0;refunds = [];
}
test('baseline request retries and parallel requests consume exactly one credit', async () => {
  reset();await Promise.all([api.requestLab(7, '123 Sample Street', 'request-0001'), api.requestLab(7, '123 Sample Street', 'request-0001')]);
  assert.equal(member.labCreditsRemaining, 1);assert.equal(records.length, 1);
  await api.requestLab(7, '123 Sample Street', 'request-0002');assert.equal(member.labCreditsRemaining, 1);
});
test('trial gate and Day-90 second-panel gate are enforced by the server', async () => {
  reset();member.trialEndsAt = new Date(Date.now() + day);await assert.rejects(api.requestLab(7, '123 Sample Street', 'request-0001'));assert.equal(member.labCreditsRemaining, 2);
  member.trialEndsAt = new Date(0);member.labCreditsRemaining = 1;
  await assert.rejects(api.requestLab(7, '123 Sample Street', 'request-0001'));
  member.purchasedAt = new Date(Date.now() - 89 * day);await api.requestLab(7, '123 Sample Street', 'request-0001');assert.equal(member.labCreditsRemaining, 0);
});
test('guidance-only memberships cannot redeem labs or gym sessions even with stray credits', async () => {
  reset();member.offerSnapshot = { region: 'REST_INDIA' };
  await assert.rejects(api.requestLab(7, '123 Sample Street', 'request-remote'));
  await assert.rejects(api.consumeSession(7, 'FREE_SESSION', 99, 'session-remote'), { status: 403 });
  await assert.rejects(api.consumeSession(7, 'ADDON_SESSION', 99, 'session-remote'), { status: 403 });
  assert.equal(records.length, 0);
  assert.equal(member.labCreditsRemaining, 2);
});
test('a configured single-panel plan books a baseline rather than waiting until Day 90', async () => {
  reset();member.planType = 'MONTHLY_4499';member.offerSnapshot = { region: 'GURUGRAM', labCredits: 1, benefits: { doorstepLabs: true } };member.labCreditsRemaining = 1;
  await api.requestLab(7, '123 Sample Street', 'request-single-panel');
  assert.equal(member.labCreditsRemaining, 0);assert.equal(records[0].details.panel, 'BASELINE');
});
test('session completion is idempotent and cannot overdraw the final session', async () => {
  reset();await Promise.all([api.consumeSession(7, 'FREE_SESSION', 99, 'session-0001'), api.consumeSession(7, 'FREE_SESSION', 99, 'session-0001')]);assert.equal(member.freeDelightSessionsRemaining, 1);
  const outcomes = await Promise.allSettled([api.consumeSession(7, 'FREE_SESSION', 99, 'session-0002'), api.consumeSession(7, 'FREE_SESSION', 99, 'session-0003')]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);assert.equal(member.freeDelightSessionsRemaining, 0);
});
test('RED requires clearance; expired purchased sessions cannot be consumed', async () => {
  reset();context.riskBucket = 'RED';await assert.rejects(api.consumeSession(7, 'FREE_SESSION', 99, 'session-0001'));assert.equal(member.freeDelightSessionsRemaining, 2);
  context.riskBucket = 'GREEN';context.clinicalStatus = 'NOT_CLEARED';await assert.rejects(api.consumeSession(7, 'FREE_SESSION', 99, 'session-0001'));
  context.clinicalStatus = 'CLEARED';grants = [{ id: 1, remaining: 4, expiresAt: new Date(0) }];await assert.rejects(api.consumeSession(7, 'ADDON_SESSION', 99, 'session-0001'));
  grants.push({ id: 2, remaining: 4, expiresAt: new Date(Date.now() + day) });await api.consumeSession(7, 'ADDON_SESSION', 99, 'session-0001');assert.equal(grants[1].remaining, 3);
});
test('concurrent guarantee requests create one provider refund and revoke the same paid order', async () => {
  reset();member.trialEndsAt = new Date(Date.now() + day);
  await Promise.all([api.requestCoachingRefund(7), api.requestCoachingRefund(7)]);
  assert.equal(refundCalls, 1);assert.equal(order.status, 'REFUNDED');assert.equal(member.planStatus, 'REFUNDED');assert.equal(member.labCreditsRemaining, 0);
});
test('a stale refund lease recovers the accepted refund receipt without issuing a second refund', async () => {
  reset();order.status = 'REFUND_PROCESSING';order.updatedAt = new Date(Date.now() - 180000);refunds = [{ id: 'refund_existing', receipt: 'coaching-refund-1', status: 'processed' }];
  await api.refundCoachingOrder(1);assert.equal(refundCalls, 0);assert.equal(order.refundId, 'refund_existing');assert.equal(order.status, 'REFUNDED');
});
