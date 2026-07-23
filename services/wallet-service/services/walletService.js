import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
const prisma = new PrismaClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

async function internalHeadersFor(targetUrl) {
  return { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(targetUrl)) } };
}

// Denormalizes gym city onto the subscription_purchased_wallet analytics
// event (kept separate from the customer-facing subscription response —
// this is purely for the controller's track() call, not part of the API
// shape). Memoized for the same reason as booking-service's copy of this
// helper: a ~1hr-stale city name is an acceptable tradeoff for not adding a
// gym-service round trip to every tracked event, and a lookup failure must
// never block the purchase it's attached to.
const GYM_CITY_CACHE_TTL_MS = 60 * 60 * 1000;
const gymCityCache = new Map(); // gymId -> { city, expiresAt }

export async function getGymCity(gymId) {
  const cached = gymCityCache.get(gymId);
  if (cached && cached.expiresAt > Date.now()) return cached.city;
  try {
    const res = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
    const city = (res.data?.data || res.data)?.city ?? null;
    gymCityCache.set(gymId, { city, expiresAt: Date.now() + GYM_CITY_CACHE_TTL_MS });
    return city;
  } catch (_) {
    return null;
  }
}

// No per-gym override today — a single platform-wide rate taken at purchase
// time and snapshotted onto the GymSubscription row for auditability.
export const SUBSCRIPTION_COMMISSION_PERCENT = Number(process.env.SUBSCRIPTION_COMMISSION_PERCENT) || 20;

const PLAN_DAYS = { weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };
const PLAN_PRICE_FIELD = {
  weekly: 'weeklyPlanPrice',
  monthly: 'monthlyPlanPrice',
  quarterly: 'quarterlyPlanPrice',
  yearly: 'yearlyPlanPrice',
};

// Wallet/WalletTransaction/RazorpayOrder store money as Prisma Decimal for
// storage/arithmetic precision, but the API's wire format stays numeric (JS
// number) — clients weren't written to parse decimal strings. Convert at the
// read boundary, immediately after every Prisma read, so every caller past
// this point (controllers, analytics, cross-service calls) just sees plain
// numbers and never has to think about Decimal.
function serializeWallet(wallet) {
  if (!wallet) return wallet;
  return { ...wallet, balance: Number(wallet.balance) };
}
function serializeTransaction(tx) {
  if (!tx) return tx;
  return { ...tx, amount: Number(tx.amount) };
}
function serializeOrder(order) {
  if (!order) return order;
  return { ...order, amount: Number(order.amount) };
}

// Batch-fetches {name, phone} per userId from auth-service's internal
// endpoint so admin views never show a bare numeric userId when real money
// is about to move. Best-effort: a lookup failure degrades to nulls rather
// than blocking the balances/payout view.
//
// Uses POST /internal/users/batch (one round trip for all rows) rather than
// N parallel single-user GETs. Falls back to nulls for every row on failure,
// same as before.
async function enrichWithUserInfo(rows) {
  const ids = [...new Set(rows.map((row) => row.userId))];
  if (!ids.length) return rows;
  const infoMap = new Map();
  try {
    const internalHeaders = { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(AUTH_SERVICE_URL)) } };
    const res = await axios.post(`${AUTH_SERVICE_URL}/internal/users/batch`, { ids }, internalHeaders);
    for (const user of res.data?.data ?? []) {
      infoMap.set(user.id, { name: user.name ?? null, phone: user.phone ?? null });
    }
  } catch (_) {
    // best-effort — leave infoMap empty, every row falls back to nulls below
  }
  return rows.map((row) => ({ ...row, ...(infoMap.get(row.userId) ?? { name: null, phone: null }) }));
}

export async function createWalletService(userId, userType) {
  try {
    const wallet = await prisma.wallet.create({
      data: { userId, userType }
    });
    return serializeWallet(wallet);
  } catch (err) {
    throw new Error('Could not create wallet: ' + err.message);
  }
}

export async function getWalletService(userId) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error('Wallet not found');
  return serializeWallet(wallet);
}

export async function getWalletTransactionsService(userId) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    include: { transactions: { orderBy: { createdAt: 'desc' } } },
  });
  if (!wallet) throw new Error('Wallet not found');
  return wallet.transactions.map(serializeTransaction);
}

// If idempotencyKey is provided and a transaction with that key already
// exists, this is a retry/reconciliation of an operation that already
// landed — return the wallet unchanged instead of applying it a second
// time. Lets a caller (e.g. booking-service's reservation debit) safely
// retry after a crash/timeout without risking a double-charge, and lets a
// reconciliation sweep ask "did this already happen?" via the lookup below.
async function alreadyAppliedWallet(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const existing = await prisma.walletTransaction.findUnique({ where: { idempotencyKey } });
  if (!existing) return null;
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  return serializeWallet(wallet);
}

export async function creditWalletService(userId, amount, description, idempotencyKey = null) {
  const already = await alreadyAppliedWallet(userId, idempotencyKey);
  if (already) return already;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new Error('Wallet not found');
      const updated = await tx.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } }
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'credit',
          amount,
          description,
          idempotencyKey,
        }
      });
      return updated;
    });
    return serializeWallet(updated);
  } catch (err) {
    // Unique-violation on idempotencyKey — a concurrent identical call
    // already applied it between our check and our create/insert.
    if (idempotencyKey && err.code === 'P2002') {
      return alreadyAppliedWallet(userId, idempotencyKey);
    }
    throw err;
  }
}

export async function debitWalletService(userId, amount, description, idempotencyKey = null) {
  if (!Number.isFinite(amount) || amount <= 0) {
    // Defense in depth — the controller already rejects this, but a Decimal
    // wallet.balance compared against NaN/undefined via `<` would silently
    // fail open (comparisons involving NaN are always false), so guard here
    // too regardless of who calls this service.
    throw new Error('amount must be a positive finite number');
  }
  const already = await alreadyAppliedWallet(userId, idempotencyKey);
  if (already) return already;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new Error('Wallet not found');
      if (Number(wallet.balance) < amount) throw new Error('Insufficient balance');
      const updated = await tx.wallet.update({
        where: { userId },
        data: { balance: { decrement: amount } }
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'debit',
          amount,
          description,
          idempotencyKey,
        }
      });
      return updated;
    });
    return serializeWallet(updated);
  } catch (err) {
    if (idempotencyKey && err.code === 'P2002') {
      return alreadyAppliedWallet(userId, idempotencyKey);
    }
    throw err;
  }
}

// Internal: lets a caller ask "did the operation behind this idempotency key
// actually happen?" — the basis of booking-service's stale-pending-booking
// reconciliation (was the debit applied before the process died, or not?).
export async function getTransactionByIdempotencyKeyService(idempotencyKey) {
  const tx = await prisma.walletTransaction.findUnique({ where: { idempotencyKey } });
  return serializeTransaction(tx);
}

export async function getPartnerBalancesService() {
  const wallets = await prisma.wallet.findMany({
    where: { userType: 'partner', balance: { gt: 0 } },
    orderBy: { balance: 'desc' }
  });
  return enrichWithUserInfo(wallets.map(serializeWallet));
}

export async function getPayoutHistoryService() {
  const transactions = await prisma.walletTransaction.findMany({
    where: { type: 'payout' },
    include: { wallet: true },
    orderBy: { createdAt: 'desc' }
  });
  const rows = transactions.map((t) => ({
    id: t.id,
    userId: t.wallet.userId,
    amount: Number(t.amount),
    description: t.description,
    createdAt: t.createdAt,
  }));
  return enrichWithUserInfo(rows);
}

export async function payoutWalletService(userId, amount, description) {
  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');
    const payoutAmount = amount ?? Number(wallet.balance);
    if (payoutAmount <= 0) throw new Error('Nothing to pay out');
    if (Number(wallet.balance) < payoutAmount) throw new Error('Insufficient balance');
    const updated = await tx.wallet.update({
      where: { userId },
      data: { balance: { decrement: payoutAmount } }
    });
    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'payout',
        amount: payoutAmount,
        description: description || 'Manual payout to partner'
      }
    });
    return { wallet: updated, transaction };
  });
  return { wallet: serializeWallet(result.wallet), transaction: serializeTransaction(result.transaction) };
}

export async function createRazorpayOrderService(userId, orderId, amount, extra = {}) {
  try {
    const order = await prisma.razorpayOrder.create({
      data: {
        userId,
        orderId,
        amount,
        status: 'PENDING',
        ...extra, // { purpose, gymId, planType } for subscription orders; omitted -> defaults to "topup"
      }
    });
    return serializeOrder(order);
  } catch (err) {
    throw new Error('Could not create Razorpay order: ' + err.message);
  }
}

export async function getRazorpayOrderService(orderId) {
  try {
    const order = await prisma.razorpayOrder.findUnique({
      where: { orderId }
    });
    return serializeOrder(order);
  } catch (err) {
    throw new Error('Could not get Razorpay order: ' + err.message);
  }
}

export async function claimRazorpayOrderService(orderId) {
  // Atomic UPDATE...WHERE status='PENDING' — the DB row lock makes this the
  // single point of truth for "who gets to credit this order," so the client
  // /verify call and the webhook can never both credit the same top-up.
  const result = await prisma.razorpayOrder.updateMany({
    where: { orderId, status: 'PENDING' },
    data: { status: 'PROCESSING' }
  });
  return result.count === 1;
}

export async function updateRazorpayOrderStatusService(orderId, status, razorpayPaymentId = null) {
  try {
    const data = { status };
    if (razorpayPaymentId) {
      data.razorpayPaymentId = razorpayPaymentId;
    }
    return await prisma.razorpayOrder.update({
      where: { orderId },
      data
    });
  } catch (err) {
    throw new Error('Could not update Razorpay order: ' + err.message);
  }
}

// Gym subscriptions ----------------------------------------------------------

function serializeSubscription(sub) {
  if (!sub) return sub;
  return {
    ...sub,
    price: Number(sub.price),
    commissionPct: Number(sub.commissionPct),
    partnerShare: Number(sub.partnerShare),
  };
}

// Looks up the gym's partnerId + the price for the requested plan via
// gym-service's internal endpoint. Throws (not a silent fallback) if the
// gym doesn't offer that plan — there's no sensible default price to charge.
export async function fetchGymForSubscription(gymId, planType) {
  const field = PLAN_PRICE_FIELD[planType];
  if (!field) throw { status: 400, error: 'Invalid planType' };

  let gym;
  try {
    const res = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
    gym = res.data?.data;
  } catch (err) {
    throw { status: 404, error: 'Gym not found' };
  }
  if (!gym) throw { status: 404, error: 'Gym not found' };

  const price = gym[field];
  if (price == null) throw { status: 400, error: `This gym does not offer a ${planType} plan` };

  return { partnerId: gym.partnerId, price: Number(price) };
}

// Subscriptions are paid for out of wallet balance only — never a direct
// Razorpay charge. RBI's refund-to-original-source rule requires a reversal
// to go back to wherever the money actually came from; a direct Razorpay
// charge for a specific purchase (as opposed to a wallet top-up) would mean
// any refund has to go back to the card/UPI, not into the wallet — the
// duplicate-subscription guard below deliberately reverses via
// creditWalletService (a wallet credit) exactly because the original debit
// was also a wallet debit, so that's the correct original source. Throws
// INSUFFICIENT_BALANCE (a `code`, checked by the client to route to a
// top-up) rather than silently falling back to Razorpay — that's a
// deliberate client-side decision, not something this function should make
// on the caller's behalf.
export async function purchaseSubscriptionWithWallet(customerId, gymId, planType) {
  const existingBefore = await getActiveSubscriptionService(customerId, gymId);
  if (existingBefore) {
    throw { status: 409, error: 'You already have an active subscription for this gym' };
  }

  const { partnerId, price } = await fetchGymForSubscription(gymId, planType);

  const wallet = await prisma.wallet.findUnique({ where: { userId: customerId } });
  if (!wallet || Number(wallet.balance) < price) {
    throw { status: 402, error: 'Insufficient wallet balance', code: 'INSUFFICIENT_BALANCE', price };
  }

  // No real Razorpay order exists for this path — synthesize a unique id so
  // GymSubscription.razorpayOrderId (required + unique) still has something
  // to key on, and so the debit's idempotency key is deterministic per order.
  const syntheticOrderId = `wallet_${customerId}_${gymId}_${Date.now()}`;
  await debitWalletService(
    customerId, price,
    `Subscription purchase - Gym: ${gymId}, Plan: ${planType}`,
    `subscription-wallet-order-${syntheticOrderId}`
  );

  // A concurrent purchase (e.g. a double-tap racing this same function on
  // another request) could have landed between the check above and this
  // debit — guard again and reverse the wallet debit if so.
  const existingAfter = await getActiveSubscriptionService(customerId, gymId);
  if (existingAfter) {
    await creditWalletService(customerId, price,
      `Refund - already subscribed to gym ${gymId} (wallet order ${syntheticOrderId})`);
    throw { status: 409, error: 'You already have an active subscription for this gym' };
  }

  const commissionPct = SUBSCRIPTION_COMMISSION_PERCENT;
  const partnerShare = Math.round(price * (1 - commissionPct / 100) * 100) / 100;
  const days = PLAN_DAYS[planType];
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);

  await prisma.wallet.upsert({
    where: { userId: partnerId },
    update: {},
    create: { userId: partnerId, userType: 'partner' },
  });
  await creditWalletService(partnerId, partnerShare, `Subscription purchase - Gym: ${gymId}, Plan: ${planType}`);

  const subscription = await prisma.gymSubscription.create({
    data: {
      customerId,
      gymId,
      partnerId,
      planType,
      price,
      commissionPct,
      partnerShare,
      startDate,
      endDate,
      razorpayOrderId: syntheticOrderId,
    },
  });

  return serializeSubscription(subscription);
}

// Used by booking-service (internal, requireInternal) at booking-creation
// time to decide whether to skip the per-session wallet debit.
export async function getActiveSubscriptionService(customerId, gymId) {
  const now = new Date();
  const sub = await prisma.gymSubscription.findFirst({
    where: { customerId, gymId, status: 'active', startDate: { lte: now }, endDate: { gte: now } },
  });
  return serializeSubscription(sub);
}

// Customer-facing list — lets the app show "already subscribed here" before
// re-selling a plan for the same gym.
export async function getMySubscriptionsService(customerId, gymId) {
  const subs = await prisma.gymSubscription.findMany({
    where: { customerId, ...(gymId ? { gymId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  return subs.map(serializeSubscription);
}
