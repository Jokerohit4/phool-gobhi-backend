// Core business-logic tests for services/walletService.js — wallet CRUD,
// Razorpay order lifecycle, credit/debit with idempotency, and balance
// enforcement. Uses node:test + node:assert/strict with t.mock.module().
//
// Run:
//   node --experimental-test-module-mocks --test test/walletService.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

let creditWalletService, debitWalletService;
let getWalletService, getWalletTransactionsService, createWalletService;
let createRazorpayOrderService, getRazorpayOrderService,
    claimRazorpayOrderService, updateRazorpayOrderStatusService;
let getTransactionByIdempotencyKeyService;

// Shared mock prisma — every test mutates its methods before calling a service.
let mockPrisma;

const USER_ID = 10;

test('setup: mock dependencies and import walletService', async (t) => {
  mockPrisma = {
    wallet: {},
    walletTransaction: {},
    razorpayOrder: {},
    $transaction: async (fn) => fn(mockPrisma),
  };

  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() { return mockPrisma; }
      },
      Prisma: {},
    },
  });

  t.mock.module('../utils/analytics.js', {
    exports: { track: () => {} },
  });

  ({
    creditWalletService,
    debitWalletService,
    getWalletService,
    getWalletTransactionsService,
    createWalletService,
    createRazorpayOrderService,
    getRazorpayOrderService,
    claimRazorpayOrderService,
    updateRazorpayOrderStatusService,
    getTransactionByIdempotencyKeyService,
  } = await import('../services/walletService.js'));

  assert.equal(typeof creditWalletService, 'function');
  assert.equal(typeof debitWalletService, 'function');
});

// =========================================================================
// createRazorpayOrderService
// =========================================================================

test('createRazorpayOrder: stores order in DB with PENDING status', async () => {
  let captured;
  mockPrisma.razorpayOrder.create = async (args) => {
    captured = args.data;
    return { ...args.data, id: 1, createdAt: new Date(), updatedAt: new Date() };
  };

  const order = await createRazorpayOrderService(USER_ID, 'order_abc', 500);

  assert.equal(captured.userId, USER_ID);
  assert.equal(captured.orderId, 'order_abc');
  assert.equal(captured.amount, 500);
  assert.equal(captured.status, 'PENDING');
  assert.equal(order.orderId, 'order_abc');
  assert.equal(order.amount, 500);
});

test('createRazorpayOrder: passes extra fields (purpose, gymId, planType)', async () => {
  let captured;
  mockPrisma.razorpayOrder.create = async (args) => {
    captured = args.data;
    return { ...args.data, id: 1, createdAt: new Date(), updatedAt: new Date() };
  };

  await createRazorpayOrderService(USER_ID, 'order_sub_1', 1999, {
    purpose: 'subscription', gymId: 42, planType: 'monthly',
  });

  assert.equal(captured.purpose, 'subscription');
  assert.equal(captured.gymId, 42);
  assert.equal(captured.planType, 'monthly');
});

test('createRazorpayOrder: throws on DB error', async () => {
  mockPrisma.razorpayOrder.create = async () => {
    throw new Error('DB connection lost');
  };

  await assert.rejects(
    () => createRazorpayOrderService(USER_ID, 'order_x', 500),
    { message: /Could not create Razorpay order/ },
  );
});

// =========================================================================
// getRazorpayOrderService / claimRazorpayOrderService / updateStatus
// =========================================================================

test('getRazorpayOrder: returns serialized order (amount string -> number)', async () => {
  mockPrisma.razorpayOrder.findUnique = async () => ({
    id: 1, userId: USER_ID, orderId: 'order_abc', amount: '500', status: 'PENDING',
  });

  const order = await getRazorpayOrderService('order_abc');
  assert.equal(order.orderId, 'order_abc');
  assert.equal(order.amount, 500);
});

test('getRazorpayOrder: returns null for unknown order', async () => {
  mockPrisma.razorpayOrder.findUnique = async () => null;
  assert.equal(await getRazorpayOrderService('nonexistent'), null);
});

test('claimRazorpayOrder: returns true when PENDING order claimed (count=1)', async () => {
  mockPrisma.razorpayOrder.updateMany = async () => ({ count: 1 });
  assert.equal(await claimRazorpayOrderService('order_abc'), true);
});

test('claimRazorpayOrder: returns false when already claimed (count=0)', async () => {
  mockPrisma.razorpayOrder.updateMany = async () => ({ count: 0 });
  assert.equal(await claimRazorpayOrderService('order_abc'), false);
});

test('updateRazorpayOrderStatus: sets status and paymentId', async () => {
  let captured;
  mockPrisma.razorpayOrder.update = async (args) => {
    captured = args;
    return { ...args.data, orderId: args.where.orderId };
  };

  await updateRazorpayOrderStatusService('order_abc', 'SUCCESS', 'pay_xyz');
  assert.equal(captured.where.orderId, 'order_abc');
  assert.equal(captured.data.status, 'SUCCESS');
  assert.equal(captured.data.razorpayPaymentId, 'pay_xyz');
});

test('updateRazorpayOrderStatus: works without paymentId', async () => {
  let captured;
  mockPrisma.razorpayOrder.update = async (args) => {
    captured = args;
    return { ...args.data, orderId: args.where.orderId };
  };

  await updateRazorpayOrderStatusService('order_abc', 'FAILED');
  assert.equal(captured.data.status, 'FAILED');
  assert.equal(captured.data.razorpayPaymentId, undefined);
});

// =========================================================================
// creditWalletService
// =========================================================================

test('creditWallet: upserts wallet, increments balance, creates CREDIT transaction', async () => {
  let capturedTxData;
  let balance = 100;

  mockPrisma.walletTransaction.findUnique = async () => null;
  mockPrisma.wallet.upsert = async () => ({ id: 1, userId: USER_ID, balance: '100' });
  mockPrisma.wallet.findUniqueOrThrow = async () => ({ id: 1, userId: USER_ID, balance: String(balance) });
  mockPrisma.wallet.update = async (args) => {
    balance += args.data.balance.increment;
    return { id: 1, userId: USER_ID, balance: String(balance) };
  };
  mockPrisma.walletTransaction.create = async (args) => { capturedTxData = args.data; };

  const wallet = await creditWalletService(USER_ID, 50, 'Top-up');

  assert.equal(wallet.balance, 150);
  assert.equal(capturedTxData.type, 'credit');
  assert.equal(capturedTxData.amount, 50);
  assert.equal(capturedTxData.description, 'Top-up');
});

test('creditWallet: creates wallet if none exists (upsert handles missing row)', async () => {
  mockPrisma.walletTransaction.findUnique = async () => null;
  mockPrisma.wallet.upsert = async (args) => ({
    id: 1, userId: args.create.userId || args.where.userId, balance: '0',
    userType: args.create.userType || 'customer',
  });
  mockPrisma.wallet.findUniqueOrThrow = async () => ({ id: 1, userId: USER_ID, balance: '0' });
  mockPrisma.wallet.update = async (args) => ({
    id: 1, userId: USER_ID, balance: String(args.data.balance.increment),
  });
  mockPrisma.walletTransaction.create = async () => {};

  const wallet = await creditWalletService(USER_ID, 200, 'New wallet credit');
  assert.equal(wallet.balance, 200);
});

test('creditWallet: idempotent — skips transaction when key already applied', async () => {
  let transactionRan = false;
  mockPrisma.walletTransaction.findUnique = async () =>
    ({ id: 1, walletId: 1, type: 'credit', idempotencyKey: 'key-1' });
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: '200' });
  mockPrisma.$transaction = async (fn) => { transactionRan = true; return fn(mockPrisma); };

  const wallet = await creditWalletService(USER_ID, 50, 'Top-up', 'key-1');
  assert.equal(wallet.balance, 200);
  assert.equal(transactionRan, false);
});

test('creditWallet: handles P2002 unique violation by returning existing state', async () => {
  const p2002 = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
  let findUniqueCall = 0;

  mockPrisma.walletTransaction.findUnique = async () => {
    findUniqueCall++;
    return findUniqueCall <= 1 ? null : { id: 1, walletId: 1, type: 'credit', idempotencyKey: 'race-key' };
  };
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: '200' });
  mockPrisma.wallet.upsert = async () => ({ id: 1, userId: USER_ID, balance: '100' });
  mockPrisma.wallet.findUniqueOrThrow = async () => ({ id: 1, userId: USER_ID, balance: '100' });
  mockPrisma.wallet.update = async () => { throw p2002; };
  mockPrisma.walletTransaction.create = async () => { throw p2002; };

  const wallet = await creditWalletService(USER_ID, 50, 'Top-up', 'race-key');
  assert.equal(wallet.balance, 200);
});

// =========================================================================
// debitWalletService
// =========================================================================

test('debitWallet: sufficient balance succeeds and deducts', async () => {
  let capturedTxData;
  let balance = 100;

  mockPrisma.walletTransaction.findUnique = async () => null;
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: String(balance) });
  mockPrisma.wallet.updateMany = async (args) => {
    if (balance >= args.where.balance.gte) {
      balance -= args.data.balance.decrement;
      return { count: 1 };
    }
    return { count: 0 };
  };
  mockPrisma.walletTransaction.create = async (args) => { capturedTxData = args.data; };

  const wallet = await debitWalletService(USER_ID, 30, 'Session booking');

  assert.equal(wallet.balance, 70);
  assert.equal(capturedTxData.type, 'debit');
  assert.equal(capturedTxData.amount, 30);
});

test('debitWallet: insufficient balance throws', async () => {
  mockPrisma.walletTransaction.findUnique = async () => null;
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: '50' });
  mockPrisma.wallet.updateMany = async () => ({ count: 0 });

  await assert.rejects(
    () => debitWalletService(USER_ID, 100, 'Too much'),
    { message: 'Insufficient balance' },
  );
});

test('debitWallet: wallet not found throws', async () => {
  mockPrisma.walletTransaction.findUnique = async () => null;
  mockPrisma.wallet.findUnique = async () => null;

  await assert.rejects(
    () => debitWalletService(999, 50, 'No wallet'),
    { message: 'Wallet not found' },
  );
});

test('debitWallet: rejects zero amount', async () => {
  await assert.rejects(
    () => debitWalletService(USER_ID, 0, 'Zero'),
    { message: 'amount must be a positive finite number' },
  );
});

test('debitWallet: rejects negative amount', async () => {
  await assert.rejects(
    () => debitWalletService(USER_ID, -10, 'Negative'),
    { message: 'amount must be a positive finite number' },
  );
});

test('debitWallet: rejects NaN amount', async () => {
  await assert.rejects(
    () => debitWalletService(USER_ID, NaN, 'NaN'),
    { message: 'amount must be a positive finite number' },
  );
});

test('debitWallet: idempotent — returns existing wallet when key already applied', async () => {
  let transactionRan = false;
  mockPrisma.walletTransaction.findUnique = async () =>
    ({ id: 1, walletId: 1, type: 'debit', idempotencyKey: 'deb-key' });
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: '200' });
  mockPrisma.$transaction = async (fn) => { transactionRan = true; return fn(mockPrisma); };

  const wallet = await debitWalletService(USER_ID, 50, 'Booking', 'deb-key');
  assert.equal(wallet.balance, 200);
  assert.equal(transactionRan, false);
});

test('debitWallet: allowNegative bypasses balance >= amount guard', async () => {
  let balance = 30;
  mockPrisma.walletTransaction.findUnique = async () => null;
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: String(balance) });
  mockPrisma.wallet.updateMany = async (args) => {
    if (args.where.balance) return { count: 0 };
    balance -= args.data.balance.decrement;
    return { count: 1 };
  };
  mockPrisma.walletTransaction.create = async () => {};

  const wallet = await debitWalletService(USER_ID, 100, 'SaaS fee', null, null, { allowNegative: true });
  assert.equal(wallet.balance, -70);
});

// =========================================================================
// getWalletService / getWalletTransactionsService / createWalletService
// =========================================================================

test('getWallet: returns serialized wallet (balance string -> number)', async () => {
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: '150.5' });
  const wallet = await getWalletService(USER_ID);
  assert.equal(wallet.balance, 150.5);
});

test('getWallet: throws when wallet not found', async () => {
  mockPrisma.wallet.findUnique = async () => null;
  await assert.rejects(() => getWalletService(999), { message: 'Wallet not found' });
});

test('getWalletTransactions: returns transactions mapped with serialized amounts', async () => {
  mockPrisma.wallet.findUnique = async () => ({
    id: 1, userId: USER_ID, balance: '100',
    transactions: [
      { id: 2, amount: '30', type: 'debit', createdAt: new Date('2026-09-02') },
      { id: 1, amount: '100', type: 'credit', createdAt: new Date('2026-09-01') },
    ],
  });
  const txs = await getWalletTransactionsService(USER_ID);
  assert.equal(txs.length, 2);
  assert.equal(txs[0].amount, 30);
  assert.equal(txs[1].amount, 100);
});

test('getWalletTransactions: throws when wallet not found', async () => {
  mockPrisma.wallet.findUnique = async () => null;
  await assert.rejects(() => getWalletTransactionsService(999), { message: 'Wallet not found' });
});

test('getWalletTransactions: returns empty array for wallet with no transactions', async () => {
  mockPrisma.wallet.findUnique = async () => ({ id: 1, userId: USER_ID, balance: '0', transactions: [] });
  const txs = await getWalletTransactionsService(USER_ID);
  assert.deepEqual(txs, []);
});

test('createWallet: creates and returns new wallet with zero balance', async () => {
  mockPrisma.wallet.create = async (args) => ({
    id: 5, balance: '0', createdAt: new Date(), updatedAt: new Date(),
    ...args.data,
  });
  const wallet = await createWalletService(42, 'partner');
  assert.equal(wallet.userId, 42);
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.userType, 'partner');
});

// =========================================================================
// getTransactionByIdempotencyKeyService
// =========================================================================

test('getTransactionByIdempotencyKey: returns serialized transaction', async () => {
  mockPrisma.walletTransaction.findUnique = async () => ({
    id: 1, walletId: 1, type: 'credit', amount: '25', idempotencyKey: 'key-abc',
  });
  const tx = await getTransactionByIdempotencyKeyService('key-abc');
  assert.equal(tx.amount, 25);
  assert.equal(tx.idempotencyKey, 'key-abc');
});

test('getTransactionByIdempotencyKey: returns null when not found', async () => {
  mockPrisma.walletTransaction.findUnique = async () => null;
  const tx = await getTransactionByIdempotencyKeyService('nonexistent');
  assert.equal(tx, null);
});
