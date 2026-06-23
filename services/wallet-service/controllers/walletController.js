import {
  createWalletService,
  getWalletService,
  getWalletTransactionsService,
  creditWalletService,
  debitWalletService,
  createRazorpayOrderService,
  getRazorpayOrderService,
  updateRazorpayOrderStatusService
} from '../services/walletService.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { track } from '../utils/analytics.js';

export const createWallet = async (req, res) => {
  try {
    const { userId, userType } = req.body;
    const wallet = await createWalletService(userId, userType);
    res.status(201).json({ data: wallet });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const getMyWallet = async (req, res) => {
  try {
    let wallet;
    try {
      wallet = await getWalletService(req.userId);
    } catch (_) {
      wallet = await createWalletService(req.userId, req.userRole || 'customer');
    }
    res.json({ data: wallet });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

export const getWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    let wallet;
    try {
      wallet = await getWalletService(Number(userId));
    } catch (err) {
      // Auto-provision a wallet on first read so the client never 404s
      wallet = await createWalletService(Number(userId), req.userRole || 'customer');
    }
    res.json({ data: wallet });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

export const getWalletTransactions = async (req, res) => {
  try {
    const { userId } = req.params;
    const transactions = await getWalletTransactionsService(Number(userId));
    res.json({ data: transactions });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

export const creditWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const result = await creditWalletService(Number(userId), amount, description);
    res.json({ data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const debitWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const result = await debitWalletService(Number(userId), amount, description);
    res.json({ data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const createTopUpOrder = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.userId; // from JWT middleware

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_SECRET
    });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paise
      currency: 'INR',
      metadata: { userId }
    });

    // Store order in DB
    await createRazorpayOrderService(userId, order.id, amount);

    track('wallet_topup_order_created', userId, { amount, order_id: order.id });

    res.status(201).json({
      data: {
        id: order.id,
        orderId: order.id,
        amount,
        currency: 'INR',
        keyId: process.env.RAZORPAY_KEY_ID
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const verifyAndCreditWallet = async (req, res) => {
  try {
    const { orderId, razorpayPaymentId, razorpaySignature } = req.body;
    const userId = req.userId;

    // Verify signature
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET);
    hmac.update(orderId + '|' + razorpayPaymentId);
    const hash = hmac.digest('hex');

    if (hash !== razorpaySignature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Check order exists and is pending (idempotency)
    const order = await getRazorpayOrderService(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'PENDING') {
      return res.status(400).json({ error: 'Order already processed' });
    }

    // Credit wallet (top-up)
    const result = await creditWalletService(userId, order.amount, `Top-up via Razorpay - Order: ${orderId}`);

    // Update order status
    await updateRazorpayOrderStatusService(orderId, 'SUCCESS', razorpayPaymentId);

    track('wallet_topup_succeeded', userId, { amount: order.amount, order_id: orderId });

    res.json({
      data: {
        success: true,
        balance: result.balance,
        transactionId: orderId
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const handleRazorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    const body = JSON.stringify(req.body);

    // Verify webhook signature
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body);
    const hash = hmac.digest('hex');

    if (hash !== signature) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = req.body.event;

    if (event === 'payment.authorized') {
      const { id: paymentId, order_id: orderId } = req.body.payload.payment.entity;
      const order = await getRazorpayOrderService(orderId);

      if (order && order.status === 'PENDING') {
        await creditWalletService(order.userId, order.amount, `Top-up via Razorpay - Order: ${orderId}`);
        await updateRazorpayOrderStatusService(orderId, 'SUCCESS', paymentId);
        track('wallet_topup_succeeded', order.userId, { amount: order.amount, order_id: orderId, via: 'webhook' });
      }
    } else if (event === 'payment.failed') {
      const { order_id: orderId } = req.body.payload.payment.entity;
      const order = await getRazorpayOrderService(orderId);

      if (order && order.status === 'PENDING') {
        await updateRazorpayOrderStatusService(orderId, 'FAILED', null);
        track('wallet_topup_failed', order.userId, { amount: order.amount, order_id: orderId });
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(200).json({ received: true }); // Return 200 to prevent Razorpay retries
  }
};
