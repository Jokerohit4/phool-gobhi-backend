import { Router } from 'express';
import {
  createWallet,
  getWallet,
  getWalletTransactions,
  creditWallet,
  debitWallet,
  createTopUpOrder,
  verifyAndCreditWallet,
  handleRazorpayWebhook
} from '../controllers/walletController.js';
import { requireAuth, requireInternal } from '../middleware/requireAuth.js';

const router = Router();

router.post('/', requireInternal, createWallet); // Create wallet (internal)
router.get('/:userId', requireAuth, getWallet); // Get wallet by userId
router.get('/:userId/transactions', requireAuth, getWalletTransactions); // Get transactions
router.post('/:userId/credit', requireInternal, creditWallet); // Credit wallet (internal: payouts, refunds, verified top-ups)
router.post('/:userId/debit', requireInternal, debitWallet); // Debit wallet (internal: booking charges)

// Razorpay routes
router.post('/orders', requireAuth, createTopUpOrder); // Create Razorpay order
router.post('/verify', requireAuth, verifyAndCreditWallet); // Verify and credit wallet
router.post('/webhooks/razorpay', handleRazorpayWebhook); // Razorpay webhook (no auth)

export default router;
