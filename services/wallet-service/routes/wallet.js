import { Router } from 'express';
import {
  createWallet,
  getMyWallet,
  getWallet,
  getWalletTransactions,
  creditWallet,
  debitWallet,
  listPartnerBalances,
  listPayoutHistory,
  payoutPartner,
  createTopUpOrder,
  verifyAndCreditWallet,
  handleRazorpayWebhook,
  createSubscriptionOrder,
  verifySubscriptionPurchase,
  getActiveSubscriptionInternal,
  getMySubscriptions,
  getTransactionByKeyInternal,
} from '../controllers/walletController.js';
import { requireAuth, requireInternal, requireRole } from '../middleware/requireAuth.js';

const router = Router();

router.post('/', requireInternal, createWallet); // Create wallet (internal)
router.get('/balance', requireAuth, getMyWallet); // Get wallet for logged-in user
router.get('/partners/summary', requireRole('gobhi'), listPartnerBalances); // Admin: list partner balances owed
router.get('/payouts', requireRole('gobhi'), listPayoutHistory); // Admin: payout history (registered before /:userId — literal path)
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

// Gym subscription routes
router.post('/subscriptions/orders', requireAuth, createSubscriptionOrder); // Create Razorpay order for a plan
router.post('/subscriptions/verify', requireAuth, verifySubscriptionPurchase); // Verify + credit partner + create subscription
router.get('/subscriptions/mine', requireAuth, getMySubscriptions); // Customer's own subscriptions (optional ?gymId=)
router.get('/internal/subscriptions/active', requireInternal, getActiveSubscriptionInternal); // booking-service entitlement check

export default router;
