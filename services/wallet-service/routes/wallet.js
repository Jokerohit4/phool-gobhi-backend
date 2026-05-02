import { Router } from 'express';
import {
  createWallet,
  getWallet,
  getWalletTransactions,
  creditWallet,
  debitWallet
} from '../controllers/walletController.js';

const router = Router();

router.post('/', createWallet); // Create wallet
router.get('/:userId', getWallet); // Get wallet by userId
router.get('/:userId/transactions', getWalletTransactions); // Get transactions
router.post('/:userId/credit', creditWallet); // Credit wallet
router.post('/:userId/debit', debitWallet); // Debit wallet

export default router; 