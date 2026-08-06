import { Router } from 'express';
import {
  createWallet,
  getMyWallet,
  getWallet,
  getWalletTransactions,
  getMyWalletTransactions,
  creditWallet,
  debitWallet,
  listPartnerBalances,
  listPayoutHistory,
  payoutPartner,
  createTopUpOrder,
  verifyAndCreditWallet,
  handleRazorpayWebhook,
  purchaseSubscriptionWithWalletHandler,
  getActiveSubscriptionInternal,
  redeemGiftDayInternal,
  processLapsedSubscriptionsInternal,
  reconcilePendingRazorpayOrdersInternal,
  getGiftBonusPayoutsAnalytics,
  getMySubscriptions,
  ackGiftReveal,
  getTransactionByKeyInternal,
  getWalletTopupConfigHandler,
  updateWalletTopupConfigHandler,
} from '../controllers/walletController.js';
import { requireAuth, requireInternal, requireRole } from '../middleware/requireAuth.js';

const router = Router();

router.post('/', requireInternal, createWallet); // Create wallet (internal)
router.get('/balance', requireAuth, getMyWallet); // Get wallet for logged-in user
router.get('/transactions', requireAuth, getMyWalletTransactions); // Get transactions for logged-in user
router.get('/partners/summary', requireRole('gobhi'), listPartnerBalances); // Admin: list partner balances owed
router.get('/admin/analytics/gift-bonus-payouts', requireRole('gobhi'), getGiftBonusPayoutsAnalytics); // Admin: gift-day/attendance-bonus rollup
router.get('/payouts', requireRole('gobhi'), listPayoutHistory); // Admin: payout history (registered before /:userId — literal path)
router.get('/topup-config', requireRole('customer', 'gobhi'), getWalletTopupConfigHandler); // Top-up UI reads this; gobhi = admin Settings prefill (registered before /:userId — literal path)
router.put('/topup-config', requireRole('gobhi'), updateWalletTopupConfigHandler); // Admin: edit presets/allowCustomAmount/min/max
router.post('/:userId/payout', requireRole('gobhi'), payoutPartner); // Admin: record a manual payout to a partner
router.get('/:userId', requireAuth, getWallet); // Get wallet by userId
router.get('/:userId/transactions', requireAuth, getWalletTransactions); // Get transactions
router.post('/:userId/credit', requireInternal, creditWallet); // Credit wallet (internal: payouts, refunds, verified top-ups)
router.post('/:userId/debit', requireInternal, debitWallet); // Debit wallet (internal: booking charges)
router.get('/internal/transactions/by-key/:key', requireInternal, getTransactionByKeyInternal); // booking-service reconciliation lookup

// Razorpay routes
router.post('/orders', requireAuth, createTopUpOrder); // Create Razorpay order
router.post('/verify', requireAuth, verifyAndCreditWallet); // Verify and credit wallet
router.post('/webhooks/razorpay', handleRazorpayWebhook); // Razorpay webhook (no auth)

// Gym subscription routes — wallet-debit only, no direct Razorpay charge
// (see purchaseSubscriptionWithWallet for why: RBI's refund-to-original-
// source rule).
router.post('/subscriptions/purchase-with-wallet', requireAuth, purchaseSubscriptionWithWalletHandler);
router.get('/subscriptions/mine', requireAuth, getMySubscriptions); // Customer's own subscriptions (optional ?gymId=)
router.post('/subscriptions/:id/ack-gift-reveal', requireAuth, ackGiftReveal); // Customer confirms they've seen the /gift-reveal screen
router.get('/internal/subscriptions/active', requireInternal, getActiveSubscriptionInternal); // booking-service entitlement check
router.post('/internal/subscriptions/:id/redeem-gift-day', requireInternal, redeemGiftDayInternal); // booking-service, after a gift-day-covered booking
router.post('/internal/subscriptions/process-lapsed', requireInternal, processLapsedSubscriptionsInternal); // periodic sweep trigger
router.post('/internal/orders/reconcile-pending', requireInternal, reconcilePendingRazorpayOrdersInternal); // Razorpay top-up reconciliation trigger

export default router;
