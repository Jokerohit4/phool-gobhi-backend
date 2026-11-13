// Tests for the per-user lazy-reconcile throttle used by GET /wallet/balance and
// GET /wallet/transactions, and for the cache-clearing hooks on order create,
// payment verify and webhook credit. The throttle is off under `node --test`
// unless WALLET_CACHE_FORCE=1, which this file opts into.
//
// Run:
//   node --experimental-test-module-mocks --test test/reconcileThrottle.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WALLET_CACHE_FORCE = '1';

let ctl;
let throttle;
let reconcileCalls, reconcileImpl, walletReads, walletImpl, pageCalls, orderImpl, claimImpl;
const razorpayCreateImpl = async () => ({ id: 'order_new' });

const noOp = async () => {};
const USER = 7;

function mkRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  throttle._resetReconcileThrottleForTests();
  reconcileCalls = 0;
  walletReads = 0;
  pageCalls = [];
  reconcileImpl = async () => ({ credited: 0, failed: 0, unresolved: 0, total: 0 });
  walletImpl = async () => ({ id: 1, userId: USER, balance: 100 });
  orderImpl = async () => ({ orderId: 'o1', userId: USER, amount: 200, status: 'PENDING' });
  claimImpl = async () => true;
}

test('setup', async (t) => {
  t.mock.module('crypto', {
    exports: { default: { createHmac: () => ({ update() {}, digest: () => 'sig' }), timingSafeEqual: () => true } },
  });
  t.mock.module('razorpay', {
    defaultExport: class { constructor() { this.orders = { create: (...a) => razorpayCreateImpl(...a) }; } },
  });
  t.mock.module('../services/walletService.js', {
    exports: {
      createWalletService: async () => ({ id: 1, userId: USER, balance: 0 }),
      getWalletService: async (...a) => { walletReads++; return walletImpl(...a); },
      getWalletTransactionsService: noOp,
      getWalletTransactionsPageService: async (userId, opts) => {
        pageCalls.push({ userId, ...opts });
        return { items: [], meta: { nextCursor: null, hasMore: false } };
      },
      creditWalletService: async () => ({ balance: 300 }),
      debitWalletService: noOp, getPartnerBalancesService: noOp, getPayoutHistoryService: noOp,
      payoutWalletService: noOp,
      createRazorpayOrderService: noOp,
      getRazorpayOrderService: (...a) => orderImpl(...a),
      updateRazorpayOrderStatusService: noOp,
      claimRazorpayOrderService: (...a) => claimImpl(...a),
      ensurePaymentCapturedService: async () => true,
      purchaseSubscriptionWithWallet: noOp, getActiveSubscriptionService: noOp,
      getGiftEligibleLapsedSubscription: noOp, redeemGiftDayService: noOp,
      processLapsedSubscriptionsService: noOp, getGiftBonusPayoutsAnalyticsService: noOp,
      getMySubscriptionsService: noOp, ackGiftRevealService: noOp,
      getTransactionByIdempotencyKeyService: noOp, getGymCity: noOp, getUserLinkedGymId: noOp,
      reconcilePendingRazorpayOrdersService: async (...a) => { reconcileCalls++; return reconcileImpl(...a); },
      getWalletTopupConfigCached: async () => ({ presets: [200], allowCustomAmount: false }),
      updateWalletTopupConfig: noOp, getSubscriptionSummaryByGymService: noOp,
      getCustomerIdsWithPurchasedSubscriptionService: noOp, getSubscriptionsForGymService: noOp,
      assertPartnerOwnsGym: noOp, recordPendingBankSettlementService: noOp,
      getPendingBankSettlementsService: noOp, settleBankSettlementsService: noOp,
      getMyBankSettlementsService: noOp, computeAttendanceSaasBillService: noOp,
      computeAttendanceSaasBillsService: noOp, applyAttendanceSaasBillService: noOp,
    },
  });
  t.mock.module('../services/exportService.js', { exports: { buildExportService: noOp } });
  t.mock.module('../utils/analytics.js', { exports: { track: () => {} } });
  throttle = await import('../utils/reconcileThrottle.js');
  ctl = await import('../controllers/walletController.js');
});

const getBalance = async () => {
  const res = mkRes();
  await ctl.getMyWallet({ userId: USER, userRole: 'customer' }, res);
  return res;
};
const getTxs = async (query = {}) => {
  const res = mkRes();
  await ctl.getMyWalletTransactions({ userId: USER, query }, res);
  return res;
};

test('throttle: second balance read within 30s skips the reconcile', async () => {
  reset();
  await getBalance();
  await getBalance();
  assert.equal(reconcileCalls, 1);
});

test('throttle: balance and transactions share one per-user window; other users unaffected', async () => {
  reset();
  await getBalance();
  await getTxs();
  assert.equal(reconcileCalls, 1);
  const out = await throttle.runReconcileThrottled(999, async () => 'x');
  assert.equal(out.skipped, false);
});

test('throttle: elapsed ttl runs the reconcile again', async (t) => {
  reset();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await getBalance();
  now += 29_000;
  await getBalance();
  assert.equal(reconcileCalls, 1);
  now += 2_000;
  await getBalance();
  assert.equal(reconcileCalls, 2);
});

test('throttle: a reconcile that throws is not recorded as done', async () => {
  reset();
  reconcileImpl = async () => { throw new Error('razorpay down'); };
  const first = await getBalance();
  assert.equal(first.statusCode, 200, 'a reconcile failure never breaks the read');
  reconcileImpl = async () => ({ credited: 0 });
  await getBalance();
  assert.equal(reconcileCalls, 2);
  await getBalance();
  assert.equal(reconcileCalls, 2, 'a successful one is recorded');
});

test('throttle: cleared when the user creates an order', async () => {
  reset();
  await getBalance();
  const res = mkRes();
  await ctl.createTopUpOrder({ userId: USER, userRole: 'customer', body: { amount: 200 } }, res);
  assert.equal(res.statusCode, 201);
  await getBalance();
  assert.equal(reconcileCalls, 2);
});

test('throttle: cleared when the user verifies a payment', async () => {
  reset();
  await getBalance();
  const res = mkRes();
  await ctl.verifyAndCreditWallet(
    { userId: USER, userRole: 'customer', body: { orderId: 'o1', razorpayPaymentId: 'p1', razorpaySignature: 'sig' } },
    res,
  );
  assert.equal(res.statusCode, 200);
  await getBalance();
  assert.equal(reconcileCalls, 2);
});

test('throttle: cleared when a webhook credits the user', async () => {
  reset();
  await getBalance();
  const res = mkRes();
  await ctl.handleRazorpayWebhook({
    headers: { 'x-razorpay-signature': 'sig' },
    rawBody: '{}',
    body: { event: 'payment.captured', payload: { payment: { entity: { id: 'p1', order_id: 'o1' } } } },
  }, res);
  assert.equal(res.statusCode, 200);
  await getBalance();
  assert.equal(reconcileCalls, 2);
});

test('throttle: a clear during an in-flight reconcile prevents it being recorded', async () => {
  reset();
  let release;
  reconcileImpl = () => new Promise((r) => { release = r; });
  const pending = getBalance();
  await new Promise((r) => setImmediate(r));
  throttle.clearReconcileThrottle(USER);
  release({ credited: 0 });
  await pending;
  reconcileImpl = async () => ({ credited: 0 });
  await getBalance();
  assert.equal(reconcileCalls, 2);
});

test('throttle: bounded to 5000 entries, evicting the oldest', async () => {
  reset();
  for (let i = 1; i <= 5100; i++) await throttle.runReconcileThrottled(i, async () => 1);
  assert.equal(throttle._reconcileThrottleSize(), 5000);
  assert.equal((await throttle.runReconcileThrottled(1, async () => 1)).skipped, false, 'oldest was evicted');
  assert.equal((await throttle.runReconcileThrottled(5100, async () => 1)).skipped, true, 'newest retained');
});

test('balance: wallet is re-read only when the reconcile credited something', async () => {
  reset();
  await getBalance();
  assert.equal(walletReads, 1, 'nothing credited -> single read');

  reset();
  reconcileImpl = async () => ({ credited: 1, total: 1 });
  let n = 0;
  walletImpl = async () => ({ id: 1, balance: n++ === 0 ? 100 : 300 });
  const res = await getBalance();
  assert.equal(walletReads, 2);
  assert.equal(res.body.data.balance, 300, 'returns the post-credit balance');

  reset();
  reconcileImpl = async () => { throw new Error('boom'); };
  await getBalance();
  assert.equal(walletReads, 1, 'failed reconcile -> no re-read');
});

test('transactions: query params parsed with defaults 50 / max 100 and meta returned', async () => {
  reset();
  const res = await getTxs({});
  assert.deepEqual(pageCalls[0], { userId: USER, limit: 50, cursor: null });
  assert.deepEqual(res.body, { data: [], meta: { nextCursor: null, hasMore: false } });
  await getTxs({ limit: '5000', cursor: '42' });
  assert.deepEqual(pageCalls[1], { userId: USER, limit: 100, cursor: 42 });
  await getTxs({ limit: 'abc', cursor: 'zzz' });
  assert.deepEqual(pageCalls[2], { userId: USER, limit: 50, cursor: null });
});
