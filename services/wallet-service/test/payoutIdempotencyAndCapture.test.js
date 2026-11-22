// Partner payout idempotencyKey + captured-payment amount check.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let payoutWalletService, ensurePaymentCapturedService;
let mockPrisma;
let rzpPayment;
let balance;
let txRows;

test('setup', async (t) => {
  balance = 1000;
  txRows = [];
  mockPrisma = {
    wallet: {
      findUnique: async () => ({ id: 1, userId: 5, balance, updatedAt: new Date(), createdAt: new Date() }),
      updateMany: async ({ where, data }) => {
        if (balance < where.balance.gte) return { count: 0 };
        balance -= data.balance.decrement;
        return { count: 1 };
      },
    },
    walletTransaction: {
      findUnique: async ({ where }) => txRows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }) => {
        if (data.idempotencyKey && txRows.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: txRows.length + 1, createdAt: new Date(), ...data };
        txRows.push(row);
        return row;
      },
    },
    $transaction: async (fn) => fn(mockPrisma),
  };
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class { constructor() { return mockPrisma; } }, Prisma: {} },
  });
  t.mock.module('../utils/analytics.js', { exports: { track: () => {} } });
  t.mock.module('razorpay', {
    defaultExport: class { constructor() { this.payments = { fetch: async () => rzpPayment }; } },
  });
  ({ payoutWalletService, ensurePaymentCapturedService } = await import('../services/walletService.js'));
});

test('payout without idempotencyKey behaves as before (each call debits)', async () => {
  balance = 1000; txRows = [];
  await payoutWalletService(5, 100, 'x');
  await payoutWalletService(5, 100, 'x');
  assert.equal(balance, 800);
  assert.equal(txRows.length, 2);
  assert.equal(txRows[0].idempotencyKey, undefined);
});

test('payout replay with same idempotencyKey returns original and does not debit twice', async () => {
  balance = 1000; txRows = [];
  const first = await payoutWalletService(5, 100, 'x', 'k1');
  const second = await payoutWalletService(5, 100, 'x', 'k1');
  assert.equal(balance, 900);
  assert.equal(txRows.length, 1);
  assert.equal(second.transaction.id, first.transaction.id);
});

test('same key with a different amount is rejected', async () => {
  balance = 1000; txRows = [];
  await payoutWalletService(5, 100, 'x', 'k2');
  await assert.rejects(payoutWalletService(5, 200, 'x', 'k2'), /different payout/);
  assert.equal(balance, 900);
});

test('captured payment with mismatched amount is not accepted', async () => {
  rzpPayment = { status: 'captured', order_id: 'o1', amount: 50000 };
  assert.equal(await ensurePaymentCapturedService('p', { orderId: 'o1', amount: 500 }), true);
  rzpPayment = { status: 'captured', order_id: 'o1', amount: 100 };
  assert.equal(await ensurePaymentCapturedService('p', { orderId: 'o1', amount: 500 }), false);
});
