import {
  createWalletService,
  getWalletService,
  getWalletTransactionsService,
  creditWalletService,
  debitWalletService,
  getPartnerBalancesService,
  getPayoutHistoryService,
  payoutWalletService,
  createRazorpayOrderService,
  getRazorpayOrderService,
  updateRazorpayOrderStatusService,
  claimRazorpayOrderService,
  purchaseSubscriptionWithWallet,
  getActiveSubscriptionService,
  getGiftEligibleLapsedSubscription,
  redeemGiftDayService,
  processLapsedSubscriptionsService,
  getGiftBonusPayoutsAnalyticsService,
  getMySubscriptionsService,
  getTransactionByIdempotencyKeyService,
  getGymCity,
  reconcilePendingRazorpayOrdersService,
} from '../services/walletService.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { track } from '../utils/analytics.js';
import { WALLET_TOPUP_AMOUNTS } from '../utils/walletConstants.js';

// Buffer-length mismatch makes crypto.timingSafeEqual throw rather than
// return false, so a shorter/longer signature must be treated as "not
// equal" before ever reaching the constant-time comparison.
function safeEqualHex(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

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
    // Lazy Razorpay top-up reconciliation — a customer opening their wallet
    // is the exact moment a paid-but-unsettled top-up should land, so settle
    // any stale PENDING orders first. Best-effort and never allowed to break
    // the wallet read: a DB or Razorpay hiccup here must not 500 the balance.
    try {
      await reconcilePendingRazorpayOrdersService({ userId: req.userId });
    } catch (err) {
      console.error('Lazy wallet reconcile error:', err.message);
    }
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
    if (parseInt(userId) !== req.userId) return res.status(403).json({ error: 'Forbidden' });
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

export const getMyWalletTransactions = async (req, res) => {
  try {
    try {
      await reconcilePendingRazorpayOrdersService({ userId: req.userId });
    } catch (err) {
      console.error('Lazy wallet reconcile error:', err.message);
    }
    const transactions = await getWalletTransactionsService(req.userId);
    res.json({ data: transactions });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

export const getWalletTransactions = async (req, res) => {
  try {
    const { userId } = req.params;
    if (parseInt(userId) !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const transactions = await getWalletTransactionsService(Number(userId));
    res.json({ data: transactions });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

export const creditWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description, idempotencyKey, userType, gymId } = req.body;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive finite number' });
    }
    const result = await creditWalletService(Number(userId), amount, description, idempotencyKey, userType || 'customer', gymId ?? null);
    res.json({ data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const debitWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description, idempotencyKey, gymId } = req.body;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive finite number' });
    }
    const result = await debitWalletService(Number(userId), amount, description, idempotencyKey, gymId ?? null);
    res.json({ data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Internal (requireInternal): lets a caller check whether a previous
// credit/debit call it made under a given idempotency key actually landed —
// used by booking-service to reconcile a booking stuck in `pending` after a
// crash between reserving the slot and confirming payment.
export const getTransactionByKeyInternal = async (req, res) => {
  try {
    const transaction = await getTransactionByIdempotencyKeyService(req.params.key);
    res.json({ data: transaction });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const listPartnerBalances = async (req, res) => {
  try {
    const wallets = await getPartnerBalancesService();
    res.json({ data: wallets });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const listPayoutHistory = async (req, res) => {
  try {
    const payouts = await getPayoutHistoryService();
    res.json({ data: payouts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const payoutPartner = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const result = await payoutWalletService(Number(userId), amount, description);
    track('partner_payout_recorded', Number(userId), { amount: result.transaction.amount });
    res.json({ data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const createTopUpOrder = async (req, res) => {
  try {
    // Partner wallets are credited only from the platform's share of
    // completed bookings/subscriptions — dispersal to partners happens
    // manually via payoutPartner. Partners must never be able to add their
    // own money in, so top-up is customer-only.
    if (req.userRole === 'partner') {
      return res.status(403).json({ error: 'Partner wallets cannot be topped up. Balance is credited automatically from completed bookings.' });
    }
    const { amount } = req.body;
    const userId = req.userId; // from JWT middleware

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!WALLET_TOPUP_AMOUNTS.includes(amount)) {
      return res.status(400).json({
        error: `Amount must be one of: ${WALLET_TOPUP_AMOUNTS.join(', ')}`
      });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_SECRET
    });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paise
      currency: 'INR',
      notes: { userId }
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
    res.status(500).json({ error: err.error?.description || err.message || 'Server error' });
  }
};

export const verifyAndCreditWallet = async (req, res) => {
  try {
    // Defense-in-depth alongside the same guard in createTopUpOrder — a
    // partner should never be able to credit their own wallet even with a
    // forged/leaked orderId.
    if (req.userRole === 'partner') {
      return res.status(403).json({ error: 'Partner wallets cannot be topped up. Balance is credited automatically from completed bookings.' });
    }
    const { orderId, razorpayPaymentId, razorpaySignature } = req.body;
    const userId = req.userId;

    // Verify signature
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET);
    hmac.update(orderId + '|' + razorpayPaymentId);
    const hash = hmac.digest('hex');

    if (!safeEqualHex(hash, razorpaySignature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const order = await getRazorpayOrderService(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Atomically claim the order so a concurrent webhook delivery for the
    // same order can't also credit it.
    const claimed = await claimRazorpayOrderService(orderId);
    if (!claimed) {
      // Lost the race — most likely the webhook already credited this order.
      // If so, the top-up did succeed, so tell the client that instead of
      // surfacing an "already processed" error for money that did land.
      const latest = await getRazorpayOrderService(orderId);
      if (latest?.status === 'SUCCESS') {
        const wallet = await getWalletService(userId);
        return res.json({
          data: { success: true, balance: wallet.balance, transactionId: orderId }
        });
      }
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
    console.error('verifyAndCreditWallet error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

const VALID_PLAN_TYPES = ['weekly', 'monthly', 'quarterly', 'sixMonthly', 'yearly'];

export const purchaseSubscriptionWithWalletHandler = async (req, res) => {
  try {
    const { gymId, planType } = req.body;
    const userId = req.userId;

    if (!gymId || !VALID_PLAN_TYPES.includes(planType)) {
      return res.status(400).json({ error: 'gymId and a valid planType are required' });
    }

    const subscription = await purchaseSubscriptionWithWallet(userId, Number(gymId), planType);
    track('subscription_purchased_wallet', userId, {
      amount: subscription.price, gym_id: gymId, plan_type: planType, city: await getGymCity(Number(gymId)),
    });
    res.status(201).json({ data: { subscription } });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
      price: err.price,
    });
  }
};

// Internal (requireInternal): booking-service checks this at booking-creation
// time to decide whether to skip the per-session wallet debit. Falls back to
// a gift-eligible lapsed subscription (see getGiftEligibleLapsedSubscription)
// when there's no in-window one, so a customer's unused make-up visits stay
// bookable after their plan's endDate — `viaGiftDay` tells booking-service
// whether to call redeem-gift-day after creating the booking.
export const getActiveSubscriptionInternal = async (req, res) => {
  try {
    const customerId = parseInt(req.query.customerId);
    const gymId = parseInt(req.query.gymId);
    let subscription = await getActiveSubscriptionService(customerId, gymId);
    let viaGiftDay = false;
    if (!subscription) {
      subscription = await getGiftEligibleLapsedSubscription(customerId, gymId);
      viaGiftDay = !!subscription;
    }
    res.json({ data: { active: !!subscription, subscription, viaGiftDay } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal (requireInternal): booking-service calls this right after
// creating a booking against a gift-eligible lapsed subscription.
export const redeemGiftDayInternal = async (req, res) => {
  try {
    await redeemGiftDayService(parseInt(req.params.id));
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal (requireInternal): periodic sweep trigger (see deploy notes for
// how this gets invoked on a schedule) — finds every lapsed-but-not-yet-
// processed subscription and runs the gift-day/attendance-bonus close-out
// on each, so the "gift ready" push fires close to when the plan lapses
// rather than waiting for the customer to next open the app.
export const processLapsedSubscriptionsInternal = async (req, res) => {
  try {
    const result = await processLapsedSubscriptionsService();
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal (requireInternal): manual/periodic trigger for Razorpay top-up
// reconciliation — the same logic the in-process timer and the lazy
// on-wallet-read path already run, exposed so a Cloud Scheduler job (or a
// one-off curl) can force a sweep of all stale PENDING orders at once.
export const reconcilePendingRazorpayOrdersInternal = async (req, res) => {
  try {
    const userId = req.body?.userId ? Number(req.body.userId) : undefined;
    const result = await reconcilePendingRazorpayOrdersService(userId ? { userId } : {});
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Admin (requireRole('gobhi')): powers the admin portal's "Gift & Bonus
// Payouts" analytics tab.
export const getGiftBonusPayoutsAnalytics = async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 30;
    const result = await getGiftBonusPayoutsAnalyticsService(days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMySubscriptions = async (req, res) => {
  try {
    const gymId = req.query.gymId ? parseInt(req.query.gymId) : undefined;
    const subscriptions = await getMySubscriptionsService(req.userId, gymId);
    res.json({ data: subscriptions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const handleRazorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    // Verify webhook signature against the exact raw bytes Razorpay signed —
    // not a JSON.stringify of the parsed body, which can differ byte-for-byte
    // and would make every real webhook delivery fail signature checks.
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.rawBody);
    const hash = hmac.digest('hex');

    if (!safeEqualHex(hash, signature)) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = req.body.event;

    // Both events mean the charge succeeded and the money is in — cards and
    // netbanking fire payment.authorized first (and again on capture), while
    // UPI and some wallets only ever fire payment.captured. Same payload
    // shape, same credit. Without the captured branch, a UPI top-up where the
    // customer closes the app before the client-side /verify path runs would
    // never be credited.
    if (event === 'payment.authorized' || event === 'payment.captured') {
      const { id: paymentId, order_id: orderId } = req.body.payload.payment.entity;
      const order = await getRazorpayOrderService(orderId);

      // Razorpay orders are only ever created for wallet top-ups now —
      // subscriptions are paid out of wallet balance (see
      // purchaseSubscriptionWithWallet), never a direct Razorpay charge, so
      // there's no `purpose === 'subscription'` case to branch on here
      // anymore.
      if (order) {
        const claimed = await claimRazorpayOrderService(orderId);
        if (claimed) {
          await creditWalletService(order.userId, order.amount, `Top-up via Razorpay - Order: ${orderId}`);
          await updateRazorpayOrderStatusService(orderId, 'SUCCESS', paymentId);
          track('wallet_topup_succeeded', order.userId, { amount: order.amount, order_id: orderId, via: 'webhook' });
        }
      }
    } else if (event === 'payment.failed') {
      const { order_id: orderId } = req.body.payload.payment.entity;
      const order = await getRazorpayOrderService(orderId);

      if (order) {
        const claimed = await claimRazorpayOrderService(orderId);
        if (claimed) {
          await updateRazorpayOrderStatusService(orderId, 'FAILED', null);
          track('wallet_topup_failed', order.userId, { amount: order.amount, order_id: orderId });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(200).json({ received: true }); // Return 200 to prevent Razorpay retries
  }
};
