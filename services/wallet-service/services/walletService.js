import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import Razorpay from 'razorpay';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { notifyCustomer } from '../utils/notifyCustomer.js';
import { track } from '../utils/analytics.js';
import { DEFAULT_WALLET_TOPUP_CONFIG, HARD_MAX_TOPUP_AMOUNT } from '../utils/walletConstants.js';
const prisma = new PrismaClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';
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

// Same purpose as getGymCity above (denormalize context onto the
// subscription_purchased_wallet event, attendance-SaaS funnel), but
// deliberately NOT cached the same way: a per-gym cache is bounded by the
// small, slow-growing number of gyms, while a per-user cache would grow
// unbounded over the service's lifetime for no real benefit — a subscription
// purchase is rare enough per user that a live lookup here isn't a hot path.
// A lookup failure must never block the purchase it's attached to.
export async function getUserLinkedGymId(userId) {
  try {
    const res = await axios.get(`${AUTH_SERVICE_URL}/internal/${userId}`, await internalHeadersFor(AUTH_SERVICE_URL));
    return (res.data?.data || res.data)?.linkedGymId ?? null;
  } catch (_) {
    return null;
  }
}

// Attendance-SaaS wedge (finalized 2026-08-19): GymSubscription purchases no
// longer share Gym.commissionPct with one-off marketplace bookings. Instead,
// every gym gets a flat honeymoon window from its own
// Gym.partnershipStartDate (set once, at first approval) during which
// subscription purchases carry ZERO platform commission; after that window
// the platform takes a flat cut — the platform default below, or a
// per-gym override via gym-service's admin-editable
// Gym.subscriptionCommissionPct (PUT /:id/subscription-commission). This is
// deliberately decoupled from commissionPct: a customer who also books
// through the regular marketplace still pays that 20%-by-default rate on
// those bookings separately (see bookingCommissionFields in booking-service,
// unchanged by this).
const SUBSCRIPTION_SAAS_HONEYMOON_DAYS = Number(process.env.SUBSCRIPTION_SAAS_HONEYMOON_DAYS) || 30;
export const DEFAULT_SUBSCRIPTION_SAAS_COMMISSION_PERCENT = Number(process.env.SUBSCRIPTION_SAAS_COMMISSION_PERCENT) || 1;

// partnershipStartDate null (gym approved before this feature existed and
// somehow missed the migration backfill) is treated as "no honeymoon" rather
// than "always in honeymoon" — the safe direction if that ever happens is to
// undercharge zero gyms for free, not to give every unbackfilled gym an
// indefinite free ride.
function computeSubscriptionSaasCommissionPct(partnershipStartDate, overridePct) {
  const resolvedRate = overridePct ?? DEFAULT_SUBSCRIPTION_SAAS_COMMISSION_PERCENT;
  if (!partnershipStartDate) return resolvedRate;
  const honeymoonEndsAt = new Date(partnershipStartDate).getTime() + SUBSCRIPTION_SAAS_HONEYMOON_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() < honeymoonEndsAt ? 0 : resolvedRate;
}

// Admin-portal-editable wallet top-up options (presets + optional
// custom-amount range). Cached briefly since createTopUpOrder reads this on
// every top-up attempt — a short TTL bounds DB load without weakening
// enforcement: /verify never re-checks this config, it only credits
// whatever amount was already approved and stored on the RazorpayOrder row
// at order-creation time, so a few seconds of cross-instance staleness here
// can only affect whether a *new* order gets created under old-vs-new
// rules, never what an already-created order gets credited for.
const TOPUP_CONFIG_CACHE_TTL_MS = 30 * 1000;
let walletTopupConfigCache = null; // { value, expiresAt }

function serializeTopupConfig(row) {
  if (!row) return { ...DEFAULT_WALLET_TOPUP_CONFIG, updatedAt: null };
  return {
    presets: row.presets,
    allowCustomAmount: row.allowCustomAmount,
    minCustomAmount: row.minCustomAmount != null ? Number(row.minCustomAmount) : null,
    maxCustomAmount: row.maxCustomAmount != null ? Number(row.maxCustomAmount) : null,
    updatedAt: row.updatedAt,
  };
}

export async function getWalletTopupConfig() {
  const row = await prisma.walletTopupConfig.findUnique({ where: { id: 1 } });
  return serializeTopupConfig(row);
}

export async function getWalletTopupConfigCached() {
  if (walletTopupConfigCache && walletTopupConfigCache.expiresAt > Date.now()) {
    return walletTopupConfigCache.value;
  }
  const value = await getWalletTopupConfig();
  walletTopupConfigCache = { value, expiresAt: Date.now() + TOPUP_CONFIG_CACHE_TTL_MS };
  return value;
}

export async function updateWalletTopupConfig({ presets, allowCustomAmount, minCustomAmount, maxCustomAmount }, updatedBy) {
  if (!Array.isArray(presets)) {
    throw { status: 400, error: 'presets must be an array' };
  }
  const cleanPresets = [...new Set(presets.map(Number))].sort((a, b) => a - b);
  for (const p of cleanPresets) {
    if (!Number.isInteger(p) || p <= 0) {
      throw { status: 400, error: 'Each preset amount must be a positive whole number of rupees' };
    }
    if (p > HARD_MAX_TOPUP_AMOUNT) {
      throw { status: 400, error: `Preset amounts cannot exceed ₹${HARD_MAX_TOPUP_AMOUNT}` };
    }
  }

  const allowCustom = !!allowCustomAmount;
  if (cleanPresets.length === 0 && !allowCustom) {
    throw { status: 400, error: 'If there are no preset amounts, custom amounts must be allowed — customers need at least one way to top up' };
  }

  let min = null;
  let max = null;
  if (allowCustom) {
    min = Number(minCustomAmount);
    max = Number(maxCustomAmount);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw { status: 400, error: 'minCustomAmount and maxCustomAmount are required when custom amounts are allowed' };
    }
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw { status: 400, error: 'minCustomAmount and maxCustomAmount must be whole numbers of rupees' };
    }
    if (min < 1) throw { status: 400, error: 'minCustomAmount must be at least ₹1' };
    if (max > HARD_MAX_TOPUP_AMOUNT) throw { status: 400, error: `maxCustomAmount cannot exceed ₹${HARD_MAX_TOPUP_AMOUNT}` };
    if (min > max) throw { status: 400, error: 'minCustomAmount cannot be greater than maxCustomAmount' };
  }

  const saved = await prisma.walletTopupConfig.upsert({
    where: { id: 1 },
    create: { id: 1, presets: cleanPresets, allowCustomAmount: allowCustom, minCustomAmount: min, maxCustomAmount: max, updatedBy },
    update: { presets: cleanPresets, allowCustomAmount: allowCustom, minCustomAmount: min, maxCustomAmount: max, updatedBy },
  });
  walletTopupConfigCache = null; // best-effort local bust — see cache comment above re: cross-instance staleness
  return serializeTopupConfig(saved);
}

const PLAN_DAYS = { weekly: 7, monthly: 30, quarterly: 90, sixMonthly: 182, yearly: 365 };
const PLAN_PRICE_FIELD = {
  weekly: 'weeklyPlanPrice',
  monthly: 'monthlyPlanPrice',
  quarterly: 'quarterlyPlanPrice',
  sixMonthly: 'sixMonthlyPlanPrice',
  yearly: 'yearlyPlanPrice',
};

// Attendance retention mechanic (see closeOutSubscriptionIfLapsed below).
// Gift-day cap is a ceiling only — the actual grant is
// min(tierCap, daysMissed), so it's always funded from this customer's own
// already-collected subscription revenue, never a net cost. Cash-bonus
// amount IS a real cost with no funding offset (most visibly on a
// 100%-attendance weekly plan, where there's no missed-day breakage at
// all) — a deliberate marketing/retention spend, not self-funded.
const GIFT_DAY_CAP = { weekly: 1, monthly: 3, quarterly: 6, sixMonthly: 10, yearly: 20 };
const CASH_BONUS = {
  weekly: { threshold: 1.0, amount: 10 },
  monthly: { threshold: 0.6, amount: 20 },
  quarterly: { threshold: 0.6, amount: 50 },
  sixMonthly: { threshold: 0.6, amount: 100 },
  yearly: { threshold: 0.6, amount: 300 },
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

// Unlike debitWalletService, a missing wallet here is NOT a legitimate
// failure — crediting someone who has no wallet row yet just means they
// haven't been auto-provisioned on a read path (getMyWallet/getWallet) or
// ever explicitly created one. That used to throw 'Wallet not found' here,
// silently swallowed by booking-service's best-effort completeBooking payout
// (see its try/catch around the /credit call) — a partner whose wallet row
// didn't exist yet simply never got paid for a completed session, with no
// error surfaced anywhere. Upserting closes that class of bug for every
// caller of this function at once (booking payouts, subscription payouts,
// cancellation refunds), not just the one call site that first hit it.
export async function creditWalletService(userId, amount, description, idempotencyKey = null, userType = 'customer', gymId = null) {
  const already = await alreadyAppliedWallet(userId, idempotencyKey);
  if (already) return already;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.wallet.upsert({ where: { userId }, update: {}, create: { userId, userType } });
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
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
          gymId,
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

export async function debitWalletService(userId, amount, description, idempotencyKey = null, gymId = null) {
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
      // Atomic check-and-decrement: the WHERE clause re-validates
      // balance>=amount against the row's value AT UPDATE TIME under
      // Postgres's row lock, not against the `wallet` snapshot read above.
      // That snapshot is stale the instant a concurrent debit/payout on the
      // same wallet is in flight — a plain findUnique-then-update let two
      // concurrent debits both pass the same balance check and both commit,
      // driving the balance negative. `wallet` above is only used for its
      // id now, not for the balance check.
      const { count } = await tx.wallet.updateMany({
        where: { userId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (count === 0) throw new Error('Insufficient balance');
      const updated = await tx.wallet.findUnique({ where: { userId } });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'debit',
          amount,
          description,
          idempotencyKey,
          gymId,
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

// Attendance-SaaS admin rollup: per-gym subscription counts + revenue,
// keyed by gymId only — gym name/city/honeymoon status are resolved by the
// admin-portal caller against gym-service (same split as the /attendance
// admin page's by-gym view), so this stays a single-service, single-query
// endpoint. status:'active' alone doesn't mean "currently in-window" (the
// SubscriptionStatus enum only ever gets set to 'active' — nothing writes
// 'cancelled' today, and a lapsed-but-unprocessed row stays 'active'
// indefinitely), so activeCount additionally requires endDate in the future.
// Matches this file's existing style for admin rollups (getPayoutHistoryService,
// getGiftBonusPayoutsAnalyticsService): findMany + manual Map reduction, not
// Prisma groupBy.
export async function getSubscriptionSummaryByGymService() {
  const now = new Date();
  const subs = await prisma.gymSubscription.findMany({
    select: { gymId: true, status: true, endDate: true, price: true, partnerShare: true, commissionPct: true },
  });

  const byGym = new Map();
  for (const s of subs) {
    if (!byGym.has(s.gymId)) {
      byGym.set(s.gymId, {
        gymId: s.gymId,
        subscriptionCount: 0,
        activeCount: 0,
        honeymoonSubscriptionCount: 0,
        totalRevenue: 0,
        // Commission the platform is owed across this gym's subscriptions
        // (price - partnerShare per subscription) — a ceiling realized
        // progressively via per-visit payouts at booking completion, not
        // cash already banked.
        totalPlatformShare: 0,
      });
    }
    const bucket = byGym.get(s.gymId);
    const price = Number(s.price);
    const partnerShare = Number(s.partnerShare);
    bucket.subscriptionCount += 1;
    if (s.status === 'active' && s.endDate >= now) bucket.activeCount += 1;
    if (Number(s.commissionPct) === 0) bucket.honeymoonSubscriptionCount += 1;
    bucket.totalRevenue = Math.round((bucket.totalRevenue + price) * 100) / 100;
    bucket.totalPlatformShare = Math.round((bucket.totalPlatformShare + (price - partnerShare)) * 100) / 100;
  }

  return [...byGym.values()].sort((a, b) => b.totalRevenue - a.totalRevenue);
}

export async function payoutWalletService(userId, amount, description) {
  const explicitAmount = amount != null;
  if (explicitAmount && (!Number.isFinite(amount) || amount <= 0)) {
    throw new Error('Nothing to pay out');
  }

  // Bounded retry, not a single read-check-write: needed only for the "pay
  // out full balance" case (amount omitted), where the target itself is
  // read from the wallet. An explicit amount either succeeds on the first
  // atomic attempt or is genuinely insufficient (see below) — no retry
  // changes that outcome.
  for (let attempt = 0; attempt < 5; attempt++) {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');
    const payoutAmount = explicitAmount ? amount : Number(wallet.balance);
    if (payoutAmount <= 0) throw new Error('Nothing to pay out');

    const result = await prisma.$transaction(async (tx) => {
      // Atomic check-and-decrement: the WHERE clause re-validates
      // balance>=payoutAmount against the row's value AT UPDATE TIME under
      // Postgres's row lock, not against the `wallet` snapshot read above —
      // this is what prevents a double-clicked "Record payout" (or a race
      // with a concurrent debit) from both passing a stale check and
      // overdrawing the wallet.
      const { count } = await tx.wallet.updateMany({
        where: { userId, balance: { gte: payoutAmount } },
        data: { balance: { decrement: payoutAmount } },
      });
      if (count === 0) return null;
      const updated = await tx.wallet.findUnique({ where: { userId } });
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

    if (result) {
      return { wallet: serializeWallet(result.wallet), transaction: serializeTransaction(result.transaction) };
    }

    // count was 0 — balance moved between our read and the guarded update.
    // An explicit amount didn't change, so this is a genuine insufficient-
    // balance case, not a race worth retrying. "Full balance" retries with
    // a fresh read since the still-lower-but-nonzero balance may well be
    // payable.
    if (explicitAmount) throw new Error('Insufficient balance');
  }
  throw new Error('Insufficient balance');
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
    // Derived, not stored — booking-service needs the plan's total day count
    // to split partnerShare into a per-visit amount (partnerShare/days) and
    // has no PLAN_DAYS map of its own, so it rides along on every serialized
    // subscription instead of duplicating that map cross-service.
    days: PLAN_DAYS[sub.planType],
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

  return {
    partnerId: gym.partnerId,
    price: Number(price),
    partnershipStartDate: gym.partnershipStartDate ?? null,
    subscriptionCommissionPct: gym.subscriptionCommissionPct != null ? Number(gym.subscriptionCommissionPct) : null,
  };
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

  const { partnerId, price, partnershipStartDate, subscriptionCommissionPct: subscriptionCommissionPctOverride } = await fetchGymForSubscription(gymId, planType);

  // Same self-booking-fraud guard as booking-service's createBooking — a
  // partner shouldn't be able to buy a subscription to their own gym under
  // their own login to inflate revenue/attendance numbers.
  if (partnerId === customerId) {
    throw { status: 403, error: 'You cannot subscribe to your own gym' };
  }

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
    `subscription-wallet-order-${syntheticOrderId}`,
    gymId
  );

  // A concurrent purchase (e.g. a double-tap racing this same function on
  // another request) could have landed between the check above and this
  // debit — guard again and reverse the wallet debit if so.
  const existingAfter = await getActiveSubscriptionService(customerId, gymId);
  if (existingAfter) {
    await creditWalletService(customerId, price,
      `Refund - already subscribed to gym ${gymId} (wallet order ${syntheticOrderId})`,
      null, 'customer', gymId);
    throw { status: 409, error: 'You already have an active subscription for this gym' };
  }

  const commissionPct = computeSubscriptionSaasCommissionPct(partnershipStartDate, subscriptionCommissionPctOverride);
  // partnerShare is the plan-lifetime ceiling, not a one-time payment — the
  // partner is credited partnerShare/days per completed visit instead (see
  // bookingCommissionFields/completeBooking in booking-service), so this
  // customer's own already-collected revenue is what funds every visit
  // (including any later gift-day make-up visits) and unused days are simply
  // never paid out. Still upsert the partner's wallet row now so the first
  // per-visit credit never fails on a missing wallet (the bug that used to
  // strand a purchase in PROCESSING when a partner had no wallet yet).
  const partnerShare = Math.round(price * (1 - commissionPct / 100) * 100) / 100;
  const days = PLAN_DAYS[planType];
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);

  await prisma.wallet.upsert({
    where: { userId: partnerId },
    update: {},
    create: { userId: partnerId, userType: 'partner' },
  });

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
      payoutModel: 'perVisit',
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

async function fetchLastVisitDate(subscriptionId) {
  try {
    const res = await axios.get(
      `${BOOKING_SERVICE_URL}/internal/bookings/subscription/${subscriptionId}/last-visit-date`,
      await internalHeadersFor(BOOKING_SERVICE_URL)
    );
    return res.data?.data?.lastVisitDate ?? null; // null = no visits yet (valid), not "unknown"
  } catch (_) {
    return undefined; // booking-service unreachable — "unknown", never claim a teaser is due
  }
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000));
}

// Customer-facing list — lets the app show "already subscribed here" before
// re-selling a plan for the same gym. Also lazily closes out any lapsed,
// not-yet-processed subscription in the list (see closeOutSubscriptionIfLapsed)
// so a customer opening this screen always sees their final gift/bonus state,
// even if the daily sweep hasn't reached that row yet — and, for a still
// in-window subscription, attaches showGiftTeaser (2+ days since the last
// visit, or since the plan started if there's been no visit yet) so the app
// can surface the glowing gift-box FAB mid-period.
export async function getMySubscriptionsService(customerId, gymId) {
  const subs = await prisma.gymSubscription.findMany({
    where: { customerId, ...(gymId ? { gymId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  const now = new Date();
  const resolved = await Promise.all(subs.map(async (sub) => {
    if (!sub.closedOutAt && sub.endDate < now) return closeOutSubscriptionIfLapsed(sub.id);

    if (sub.status === 'active' && sub.endDate >= now) {
      const lastVisitDate = await fetchLastVisitDate(sub.id);
      const referenceDate = lastVisitDate ?? sub.startDate.toISOString().split('T')[0];
      const showGiftTeaser = lastVisitDate !== undefined && daysSince(referenceDate) >= 2;
      // Lets the website/app show "today's session is covered" without
      // guessing — a customer who already has a booking today at this gym
      // has used the one free/covered session this subscription grants per
      // day (see reserveBookingSlot's usedToday check). null/undefined (no
      // visit yet, or booking-service unreachable) both mean "not used today".
      return { ...serializeSubscription(sub), showGiftTeaser, lastVisitDate: lastVisitDate ?? null };
    }

    return serializeSubscription(sub);
  }));
  return resolved;
}

// Booking-service's entitlement check only ever queries an in-window
// subscription (see getActiveSubscriptionService) — gift-day redemption
// deliberately lives in its own function rather than folding into that one,
// so a customer with leftover gift days on an old plan can still buy a
// fresh subscription for the same gym without tripping purchaseSubscriptionWithWallet's
// "already have an active subscription" guard.
export async function getGiftEligibleLapsedSubscription(customerId, gymId) {
  const now = new Date();
  const lapsed = await prisma.gymSubscription.findFirst({
    where: { customerId, gymId, status: 'active', endDate: { lt: now } },
    orderBy: { endDate: 'desc' },
  });
  if (!lapsed) return null;

  const closedOut = lapsed.closedOutAt ? serializeSubscription(lapsed) : await closeOutSubscriptionIfLapsed(lapsed.id);
  if (!closedOut || closedOut.giftDaysGranted - closedOut.giftDaysRedeemed <= 0) return null;
  return closedOut;
}

// booking-service calls this right after creating a booking against a
// gift-eligible lapsed subscription (see getGiftEligibleLapsedSubscription) —
// best-effort, fire-and-forget, same pattern as the referral-credit call in
// booking-service's completeBooking. A failed increment just means this
// customer's next gift-day booking is evaluated against a stale
// giftDaysRedeemed count, which self-corrects on the next successful call
// and can never grant more than giftDaysGranted since bookingService's
// own "one free session per day" check still applies per calendar day.
export async function redeemGiftDayService(subscriptionId) {
  await prisma.gymSubscription.update({
    where: { id: subscriptionId },
    data: { giftDaysRedeemed: { increment: 1 } },
  });
}

// Customer-facing (not internal) — called when the app's /gift-reveal screen
// is actually shown, so hasUnseenGiftReveal stops matching this subscription
// on every future load. Ownership-checked since this is reachable by any
// authenticated customer, unlike the internal-only endpoints above.
export async function ackGiftRevealService(subscriptionId, customerId) {
  const { count } = await prisma.gymSubscription.updateMany({
    where: { id: subscriptionId, customerId, giftRevealSeenAt: null },
    data: { giftRevealSeenAt: new Date() },
  });
  if (count === 0) {
    // Either it doesn't exist, isn't this customer's, or was already
    // acked — any of those is fine to no-op on rather than error, since the
    // caller only wants "make sure this stops showing up."
    const exists = await prisma.gymSubscription.findFirst({
      where: { id: subscriptionId, customerId },
      select: { id: true },
    });
    if (!exists) throw { status: 404, error: 'Subscription not found' };
  }
}

async function fetchCompletedVisitCount(subscriptionId) {
  try {
    const res = await axios.get(
      `${BOOKING_SERVICE_URL}/internal/bookings/subscription/${subscriptionId}/completed-count`,
      await internalHeadersFor(BOOKING_SERVICE_URL)
    );
    return res.data?.data?.count ?? 0;
  } catch (_) {
    // booking-service unreachable — signal "unknown" so the caller can leave
    // this subscription un-closed-out and simply try again on the next read,
    // rather than guessing 0 visits and wrongly maxing out the gift-day grant.
    return null;
  }
}

// Runs once per lapsed subscription (guarded by closedOutAt), triggered
// either lazily on read (getMySubscriptionsService, getGiftEligibleLapsedSubscription)
// or by the periodic sweep (processLapsedSubscriptionsService) — whichever
// happens first. Computes the gift-day grant and attendance cash bonus and
// persists them so every later read is a no-op.
export async function closeOutSubscriptionIfLapsed(subscriptionId) {
  const sub = await prisma.gymSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return null;
  if (sub.closedOutAt || sub.endDate > new Date()) return serializeSubscription(sub);

  const daysUsed = await fetchCompletedVisitCount(subscriptionId);
  if (daysUsed == null) return serializeSubscription(sub); // try again on the next read

  const totalDays = PLAN_DAYS[sub.planType] ?? 0;
  const missedDays = Math.max(0, totalDays - daysUsed);
  const giftDaysGranted = Math.min(missedDays, GIFT_DAY_CAP[sub.planType] ?? 0);
  const attendancePct = totalDays > 0 ? daysUsed / totalDays : 0;
  const bonusConfig = CASH_BONUS[sub.planType];
  const qualifiesForBonus = !!bonusConfig && attendancePct >= bonusConfig.threshold;

  if (qualifiesForBonus) {
    try {
      await creditWalletService(
        sub.customerId, bonusConfig.amount,
        `Attendance bonus - ${sub.planType} plan`,
        `subscription-bonus-${subscriptionId}`, 'customer', sub.gymId
      );
    } catch (err) {
      // Best-effort — a failed credit shouldn't block recording the rest of
      // close-out; bonusPaid stays false below so this isn't mistaken for success.
      console.error('Subscription attendance bonus credit failed', subscriptionId, err.message);
    }
  }

  const updated = await prisma.gymSubscription.update({
    where: { id: subscriptionId },
    data: {
      giftDaysGranted,
      bonusPaid: qualifiesForBonus,
      closedOutAt: new Date(),
    },
  });

  const messageParts = [];
  if (giftDaysGranted > 0) messageParts.push(`${giftDaysGranted} bonus visit${giftDaysGranted === 1 ? '' : 's'}`);
  if (qualifiesForBonus) messageParts.push(`₹${bonusConfig.amount} in your wallet`);
  if (messageParts.length > 0) {
    notifyCustomer(sub.customerId, {
      title: 'A gift is waiting for you',
      body: `It's okay you missed a few days — here's ${messageParts.join(' and ')} to help you reach your goal.`,
      data: { type: 'gift_ready', subscriptionId: String(subscriptionId) },
    }).catch(() => {});
  }

  return serializeSubscription(updated);
}

// Admin rollup (requireRole('gobhi')) — gives visibility into what the
// gift-day/attendance-bonus mechanic is actually costing: giftDaysGranted is
// self-funded from each subscription's own breakage (see
// closeOutSubscriptionIfLapsed), but the cash bonus is a real, unfunded
// cost, most visibly on a 100%-attendance weekly plan.
export async function getGiftBonusPayoutsAnalyticsService(days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const closedOut = await prisma.gymSubscription.findMany({
    where: { closedOutAt: { gte: since } },
    select: { closedOutAt: true, planType: true, giftDaysGranted: true, bonusPaid: true },
  });

  const byDay = new Map();
  let totalGiftDays = 0;
  let totalBonusAmount = 0;
  let bonusCount = 0;
  for (const row of closedOut) {
    const day = row.closedOutAt.toISOString().split('T')[0];
    if (!byDay.has(day)) byDay.set(day, { day, giftDays: 0, bonusAmount: 0 });
    const bucket = byDay.get(day);
    bucket.giftDays += row.giftDaysGranted;
    totalGiftDays += row.giftDaysGranted;
    if (row.bonusPaid) {
      const amount = CASH_BONUS[row.planType]?.amount ?? 0;
      bucket.bonusAmount += amount;
      totalBonusAmount += amount;
      bonusCount++;
    }
  }

  return {
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    totalGiftDays,
    totalBonusAmount,
    bonusCount,
    closedOutCount: closedOut.length,
  };
}

// Bulk sweep for the periodic scheduled trigger (see deploy notes) — the
// lazy on-read close-out above already guarantees correctness even if this
// never runs; this exists purely so the "gift ready" push notification
// fires close to when the plan actually lapses, instead of waiting for the
// customer to next open the app.
export async function processLapsedSubscriptionsService() {
  const now = new Date();
  const candidates = await prisma.gymSubscription.findMany({
    where: { status: 'active', endDate: { lt: now }, closedOutAt: null },
    select: { id: true },
  });
  let processed = 0;
  for (const { id } of candidates) {
    await closeOutSubscriptionIfLapsed(id);
    processed++;
  }
  return { processed, total: candidates.length };
}

// Razorpay top-up reconciliation --------------------------------------------
//
// An order created but not settled within this window is fair game for the
// reconciler. 10 minutes gives the active Razorpay checkout plus the
// client-side /verify call plenty of time to settle normally before a
// reconcile could race it.
const RECONCILE_ORDER_AFTER_MS = 10 * 60 * 1000;

function razorpayClient() {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_SECRET,
  });
}

// Settles one stale PENDING order against Razorpay's own payment records:
//  - a captured/authorized payment => credit the wallet (same claim-then-
//    credit path the client /verify and the webhook use, so the atomic
//    PENDING->PROCESSING claim guarantees no double credit no matter which
//    of the three settles it first);
//  - only failed payments => mark the order FAILED;
//  - no payment at all (checkout abandoned mid-flight) => leave PENDING for
//    the next sweep, since the user may still complete it.
async function settleRazorpayOrder(razorpay, order) {
  // fetchPayments throws if the order is unknown to Razorpay (e.g. created
  // against a different key set) — the caller treats that as unresolved.
  const payments = await razorpay.orders.fetchPayments(order.orderId);
  const list = payments?.items ?? [];

  const succeeded = list.find((p) => p.status === 'captured' || p.status === 'authorized');
  const anyFailed = list.length > 0 && list.every((p) => p.status === 'failed');
  if (!succeeded && !anyFailed) return 'unresolved';

  const claimed = await claimRazorpayOrderService(order.orderId);
  if (!claimed) return 'unresolved'; // client /verify or webhook settled it first

  if (succeeded) {
    await creditWalletService(order.userId, order.amount, `Top-up via Razorpay - Order: ${order.orderId}`);
    await updateRazorpayOrderStatusService(order.orderId, 'SUCCESS', succeeded.id);
    track('wallet_topup_succeeded', order.userId, { amount: Number(order.amount), order_id: order.orderId, via: 'reconcile' });
    return 'credited';
  }

  await updateRazorpayOrderStatusService(order.orderId, 'FAILED');
  track('wallet_topup_failed', order.userId, { amount: Number(order.amount), order_id: order.orderId });
  return 'failed';
}

// Finds PENDING top-up orders older than the settle window and settles them
// against Razorpay. `userId` scopes it to one customer (the lazy on-read
// path); omitting it reconciles everything (the periodic sweep / internal
// trigger). Failures are swallowed per-order — a single bad order must never
// stall the rest of the sweep.
export async function reconcilePendingRazorpayOrdersService({ userId } = {}) {
  const cutoff = new Date(Date.now() - RECONCILE_ORDER_AFTER_MS);
  const candidates = await prisma.razorpayOrder.findMany({
    where: {
      purpose: 'topup',
      status: 'PENDING',
      createdAt: { lt: cutoff },
      ...(userId ? { userId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  const razorpay = razorpayClient();
  let credited = 0;
  let failed = 0;
  let unresolved = 0;

  for (const order of candidates) {
    try {
      const outcome = await settleRazorpayOrder(razorpay, order);
      if (outcome === 'credited') credited++;
      else if (outcome === 'failed') failed++;
      else unresolved++;
    } catch (err) {
      console.error(`Reconcile order ${order.orderId} error:`, err.message);
      unresolved++;
    }
  }

  return { credited, failed, unresolved, total: candidates.length };
}
