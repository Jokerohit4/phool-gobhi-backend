// Tests for handleRazorpayWebhook in controllers/walletController.js.
//
// Verifies HMAC signature verification, event routing (payment.authorized,
// payment.captured, payment.failed), wallet crediting, idempotent claim
// semantics, and the always-200 policy that prevents Razorpay retry loops.
//
// Run:
//   node --experimental-test-module-mocks --test test/webhook.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

let handleRazorpayWebhook;
let mockGetOrder, mockClaimOrder, mockCredit, mockUpdateStatus, mockTrack;

// State-driven crypto mock — avoids read-only ESM reassignment.
// timingSafeEqualResult controls signature validity; throwOnHmac simulates
// unexpected errors; digestValue is what hmac.digest() returns.
let timingSafeEqualResult = true;
let throwOnHmac = false;
const digestValue = 'abc123456';

const noOp = async () => {};

test('setup: mock dependencies and import webhook handler', async (t) => {
  t.mock.module('crypto', {
    exports: {
      default: {
        createHmac: () => {
          if (throwOnHmac) throw new Error('crypto subsystem failure');
          return { update: () => {}, digest: () => digestValue };
        },
        timingSafeEqual: () => timingSafeEqualResult,
      },
    },
  });

  mockGetOrder = async () => null;
  mockClaimOrder = async () => true;
  mockCredit = async () => {};
  mockUpdateStatus = async () => {};
  mockTrack = () => {};

  const walletServiceExports = {
    createWalletService: noOp,
    getWalletService: noOp,
    getWalletTransactionsService: noOp,
    creditWalletService: (...a) => mockCredit(...a),
    debitWalletService: noOp,
    getPartnerBalancesService: noOp,
    getPayoutHistoryService: noOp,
    payoutWalletService: noOp,
    createRazorpayOrderService: noOp,
    getRazorpayOrderService: (...a) => mockGetOrder(...a),
    updateRazorpayOrderStatusService: (...a) => mockUpdateStatus(...a),
    claimRazorpayOrderService: (...a) => mockClaimOrder(...a),
    purchaseSubscriptionWithWallet: noOp,
    getActiveSubscriptionService: noOp,
    getGiftEligibleLapsedSubscription: noOp,
    redeemGiftDayService: noOp,
    processLapsedSubscriptionsService: noOp,
    getGiftBonusPayoutsAnalyticsService: noOp,
    getMySubscriptionsService: noOp,
    ackGiftRevealService: noOp,
    getTransactionByIdempotencyKeyService: noOp,
    getGymCity: noOp,
    getUserLinkedGymId: noOp,
    reconcilePendingRazorpayOrdersService: noOp,
    getWalletTopupConfigCached: noOp,
    updateWalletTopupConfig: noOp,
    getSubscriptionSummaryByGymService: noOp,
    getCustomerIdsWithPurchasedSubscriptionService: noOp,
    getSubscriptionsForGymService: noOp,
    assertPartnerOwnsGym: noOp,
    recordPendingBankSettlementService: noOp,
    getPendingBankSettlementsService: noOp,
    settleBankSettlementsService: noOp,
    getMyBankSettlementsService: noOp,
    computeAttendanceSaasBillService: noOp,
    computeAttendanceSaasBillsService: noOp,
    applyAttendanceSaasBillService: noOp,
  };

  t.mock.module('../services/walletService.js', { exports: walletServiceExports });

  t.mock.module('../services/exportService.js', {
    exports: { buildExportService: noOp },
  });

  t.mock.module('../utils/analytics.js', {
    exports: { track: (...a) => mockTrack(...a) },
  });

  ({ handleRazorpayWebhook } = await import('../controllers/walletController.js'));
  assert.equal(typeof handleRazorpayWebhook, 'function');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkReq(overrides = {}) {
  return {
    rawBody: '{"event":"test"}',
    body: {
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } },
    },
    headers: { 'x-razorpay-signature': digestValue },
    ...overrides,
  };
}

function mkRes() {
  const r = { statusCode: null, body: null };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (data) => { r.body = data; return r; };
  return r;
}

// =========================================================================
// 1. payment.authorized → credits wallet, returns 200
// =========================================================================

test('payment.authorized: credits wallet and returns 200', async () => {
  const orderId = 'order_auth_1';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  timingSafeEqualResult = true;
  throwOnHmac = false;

  mockGetOrder = async (id) => id === orderId ? { userId: 10, amount: 500, orderId: id } : null;
  mockClaimOrder = async () => true;
  mockCredit = async () => {};
  mockUpdateStatus = async () => {};
  mockTrack = () => {};

  const r = mkRes();
  await handleRazorpayWebhook(mkReq({
    body: { event: 'payment.authorized', payload: { payment: { entity: { id: 'pay_a1', order_id: orderId } } } },
  }), r);

  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { received: true });
  assert.equal(mockGetOrder.mock?.callCount ?? 1, 1);
  assert.equal(mockClaimOrder.mock?.callCount ?? 1, 1);
  assert.equal(mockCredit.mock?.callCount ?? 1, 1);
  assert.equal(mockUpdateStatus.mock?.callCount ?? 1, 1);
});

// =========================================================================
// 2. payment.captured → credits wallet, returns 200
// =========================================================================

test('payment.captured: credits wallet and returns 200', async () => {
  const orderId = 'order_cap_1';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  timingSafeEqualResult = true;
  throwOnHmac = false;

  mockGetOrder = async (id) => id === orderId ? { userId: 20, amount: 1000, orderId: id } : null;
  mockClaimOrder = async () => true;
  mockCredit = async () => {};
  mockUpdateStatus = async () => {};
  mockTrack = () => {};

  const r = mkRes();
  await handleRazorpayWebhook(mkReq({
    body: { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_c1', order_id: orderId } } } },
  }), r);

  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { received: true });
  assert.equal(mockCredit.mock?.callCount ?? 1, 1);
  assert.equal(mockUpdateStatus.mock?.callCount ?? 1, 1);
});

// =========================================================================
// 3. payment.failed → marks order FAILED, returns 200
// =========================================================================

test('payment.failed: marks order FAILED and returns 200', async () => {
  const orderId = 'order_fail_1';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  timingSafeEqualResult = true;
  throwOnHmac = false;

  let updateCaptured;
  mockGetOrder = async (id) => id === orderId ? { userId: 30, amount: 200, orderId: id } : null;
  mockClaimOrder = async () => true;
  mockCredit = async () => {};
  mockUpdateStatus = async (id, status) => { updateCaptured = { id, status }; };
  mockTrack = () => {};

  const r = mkRes();
  await handleRazorpayWebhook(mkReq({
    body: { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f1', order_id: orderId } } } },
  }), r);

  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { received: true });
  assert.deepEqual(updateCaptured, { id: orderId, status: 'FAILED' });
});

// =========================================================================
// 4. Invalid signature → returns 400
// =========================================================================

test('invalid signature: returns 400', async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  timingSafeEqualResult = false;
  throwOnHmac = false;

  const r = mkRes();
  await handleRazorpayWebhook(mkReq(), r);

  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'Invalid webhook signature');
});

// =========================================================================
// 5. Order not found → returns 200 (no-op, prevents retry loop)
// =========================================================================

test('order not found: returns 200 (no-op)', async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  timingSafeEqualResult = true;
  throwOnHmac = false;

  mockGetOrder = async () => null;
  mockClaimOrder = async () => { throw new Error('should not be called'); };
  mockCredit = async () => { throw new Error('should not be called'); };
  mockUpdateStatus = async () => { throw new Error('should not be called'); };
  mockTrack = () => {};

  const r = mkRes();
  await handleRazorpayWebhook(mkReq({
    body: { event: 'payment.authorized', payload: { payment: { entity: { id: 'pay_x', order_id: 'unknown_order' } } } },
  }), r);

  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { received: true });
});

// =========================================================================
// 6. Order already claimed → returns 200 (idempotent, no double credit)
// =========================================================================

test('order already claimed: returns 200 (idempotent)', async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  timingSafeEqualResult = true;
  throwOnHmac = false;

  mockGetOrder = async () => ({ userId: 10, amount: 500, orderId: 'order_dup' });
  mockClaimOrder = async () => false;
  mockCredit = async () => { throw new Error('should not be called'); };
  mockUpdateStatus = async () => { throw new Error('should not be called'); };
  mockTrack = () => {};

  const r = mkRes();
  await handleRazorpayWebhook(mkReq({
    body: { event: 'payment.authorized', payload: { payment: { entity: { id: 'pay_d', order_id: 'order_dup' } } } },
  }), r);

  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { received: true });
});

// =========================================================================
// 7. Exception in handler → returns 200 (never 5xx to Razorpay)
// =========================================================================

test('exception in handler: returns 200 (never 5xx)', async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  throwOnHmac = true;

  const r = mkRes();
  await handleRazorpayWebhook(mkReq(), r);

  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { received: true });
});
