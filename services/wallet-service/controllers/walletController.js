import {
  createWalletService,
  getWalletService,
  getWalletTransactionsService,
  creditWalletService,
  debitWalletService
} from '../services/walletService.js';

export const createWallet = async (req, res) => {
  try {
    const { userId, userType } = req.body;
    const wallet = await createWalletService(userId, userType);
    res.status(201).json(wallet);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const getWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const wallet = await getWalletService(Number(userId));
    res.json(wallet);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

export const getWalletTransactions = async (req, res) => {
  try {
    const { userId } = req.params;
    const transactions = await getWalletTransactionsService(Number(userId));
    res.json(transactions);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

export const creditWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const result = await creditWalletService(Number(userId), amount, description);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const debitWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const result = await debitWalletService(Number(userId), amount, description);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}; 