// Covers the pure money serializers in services/walletService.js — Prisma
// Decimal fields (balance/amount/price/partnerShare) must reach the wire as
// JS numbers, not decimal strings, and daysSince drives the gift-teaser /
// gift-grant retention logic. These were exported for testability; every
// public caller funnels through them. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const NOW_UTC = Date.UTC(2026, 8, 14, 10, 0, 0);

let serializeTopupConfig, serializeWallet, serializeTransaction, serializeOrder,
  serializeSubscription, daysSince;

test('setup: mock @prisma/client once, import walletService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {},
      Prisma: {},
    },
  });
  ({ serializeTopupConfig, serializeWallet, serializeTransaction, serializeOrder,
     serializeSubscription, daysSince } = await import('../services/walletService.js'));
  assert.equal(typeof serializeTopupConfig, 'function');
});

test('serializeTopupConfig: null row falls back to the platform defaults with updatedAt null', () => {
  assert.deepEqual(serializeTopupConfig(null), {
    presets: [200, 500, 1000, 2000],
    allowCustomAmount: false,
    minCustomAmount: null,
    maxCustomAmount: null,
    updatedAt: null,
  });
});

test('serializeTopupConfig: Decimal custom-amount bounds become numbers', () => {
  const out = serializeTopupConfig({
    presets: [200, 1000],
    allowCustomAmount: true,
    minCustomAmount: '100',
    maxCustomAmount: '5000',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(out.minCustomAmount, 100);
  assert.equal(out.maxCustomAmount, 5000);
  assert.deepEqual(out.presets, [200, 1000]);
  assert.equal(out.allowCustomAmount, true);
  assert.equal(out.updatedAt, '2026-09-01T00:00:00.000Z');
});

test('serializeWallet: balance Decimal → number; null passes through', () => {
  assert.equal(serializeWallet({ balance: '150.5', id: 3 }).balance, 150.5);
  assert.equal(serializeWallet({ balance: 0 }).balance, 0);
  assert.equal(serializeWallet(null), null);
});

test('serializeTransaction: amount Decimal → number; null passes through', () => {
  assert.equal(serializeTransaction({ amount: '25' }).amount, 25);
  assert.equal(serializeTransaction({ amount: '0.01' }).amount, 0.01);
  assert.equal(serializeTransaction(null), null);
});

test('serializeOrder: amount Decimal → number; null passes through', () => {
  assert.equal(serializeOrder({ amount: '1000' }).amount, 1000);
  assert.equal(serializeOrder(null), null);
});

test('serializeSubscription: plan fields become numbers and days maps from planType', () => {
  const out = serializeSubscription({
    planType: 'monthly',
    price: '1999',
    commissionPct: '20',
    partnerShare: '1599.20',
    coinDiscountAmount: '99',
  });
  assert.equal(out.price, 1999);
  assert.equal(out.commissionPct, 20);
  assert.equal(out.partnerShare, 1599.2);
  assert.equal(out.coinDiscountAmount, 99);
  assert.equal(out.days, 30); // PLAN_DAYS.monthly
});

test('serializeSubscription: per-plan day counts and optional coinDiscount', () => {
  for (const [plan, days] of [['weekly', 7], ['quarterly', 90], ['sixMonthly', 182], ['yearly', 365]]) {
    assert.equal(serializeSubscription({ planType: plan }).days, days, plan);
  }
  assert.equal(serializeSubscription({ planType: 'monthly', coinDiscountAmount: null }).coinDiscountAmount, null);
  assert.equal(serializeSubscription(null), null);
});

test('daysSince: whole-day delta from the pinned clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(daysSince('2026-09-14T10:00:00.000Z'), 0);
  assert.equal(daysSince('2026-09-10T10:00:00.000Z'), 4);
  assert.equal(daysSince('2026-09-20T10:00:00.000Z'), -6);
});