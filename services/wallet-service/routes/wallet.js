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

const router = Router();

router.post('/', createWallet); // Create wallet
router.get('/:userId', getWallet); // Get wallet by userId
router.get('/:userId/transactions', getWalletTransactions); // Get transactions
router.post('/:userId/credit', creditWallet); // Credit wallet
router.post('/:userId/debit', debitWallet); // Debit wallet

// Razorpay routes
router.post('/orders', createTopUpOrder); // Create Razorpay order
router.post('/verify', verifyAndCreditWallet); // Verify and credit wallet
router.post('/webhooks/razorpay', handleRazorpayWebhook); // Razorpay webhook (no auth)

export default router;
