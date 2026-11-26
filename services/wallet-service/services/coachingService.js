import crypto from 'crypto';
import Razorpay from 'razorpay';
import axios from 'axios';
import prisma from '../db/prisma.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { track } from '../utils/analytics.js';
import { membershipBenefits, trainerAddonOffer } from './coachingCatalog.js';
import { loadCoachingOffer, loadCoachingOfferV2, loadTrainerAddon } from './coachingOfferService.js';
import { getCoachingConfig } from './coachingConfigService.js';
import { priceCoachingV2Order, V2_ADDON_BALANCES } from './coachingV2Order.js';
import { coachingPrice, couponHasCapacity, loadCoachingCoupon, redeemCoachingCoupon, rejectCoupon, releaseCouponReservations, requestedCouponCode } from './coachingCoupons.js';

export const COACHING_PRODUCTS = Object.freeze({ MONTHLY_4499: 449900, QUARTERLY_11999: 1199900, TRAINER_ADDON_1499: 149900 });
const HOUR = 3600000, DAY = HOUR * 24;
const COUPON_CHECKOUT_TTL_MS = DAY;
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';
const provider = () => new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });
const emptyV2Balances = { trainerSessionsRemaining: 0, nutritionistSessionsRemaining: 0 };
const sessionBalances = new Map([['TRAINER_SESSION', 'trainerSessionsRemaining'], ['NUTRITIONIST_SESSION', 'nutritionistSessionsRemaining']]);
const isV2 = offer => offer?.schemaVersion === 2;
export const GYM_ENTITLEMENT_SYNC = 'GYM_ENTITLEMENT_SYNC';
const termOrderRef = id => `coaching-term-${id}`;
const gymFulfillmentPaths = {
  activate: '/internal/entitlements',
  cancel: '/internal/entitlements/cancel',
  addon: '/internal/entitlements/addon-balance',
};
const includeCouponStatus = { couponRedemption: { select: { status: true } } };
function trackCoachingEvent(send) {
  try { void Promise.resolve(send()).catch(() => {}); } catch {}
}
async function withCouponTelemetry(userId, run) {
  try { return await run(); }
  catch (error) {
    if (error.couponReason) trackCoachingEvent(() => track('coupon_rejected', userId, {
      coupon_code: error.couponCode, reason: error.couponReason,
    }));
    throw error;
  }
}
export async function eraseCoachingPersonalData(userId) {
  await prisma.$transaction([
    prisma.coachingFulfillment.updateMany({ where: { userId }, data: { details: {}, status: 'CANCELLED' } }),
    prisma.coachingMembership.updateMany({ where: { userId }, data: { planStatus: 'INACTIVE', hasExistingGym: false, gymPassStatus: 'CANCELLED', freeDelightSessionsRemaining: 0, labCreditsRemaining: 0, scheduledOrderId: null, ...emptyV2Balances } }),
    prisma.coachingAddonGrant.updateMany({ where: { userId }, data: { remaining: 0 } }),
    prisma.coachingSubscription.updateMany({ where: { userId }, data: { userName: null, phone: null, riskBucket: 'UNSET', worksOut: null, hasExistingGym: false, hasNutritionist: false } }),
  ]);
  return { erased: true, financialRecordsRetained: true };
}
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function isV2Product(product) {
  if (typeof product !== 'string' || !product) fail('Choose a coaching offer');
  return !Object.hasOwn(COACHING_PRODUCTS, product);
}
async function coachingAccount(userId) {
  const url = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
  try {
    const response = await axios.get(`${url}/internal/${userId}`, { timeout: 15000, headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(url)) } });
    return response.data?.data || response.data;
  } catch (e) { if (e.response?.status === 404) return null; throw e; }
}
export function eligibleCoachingAccount(account, now = new Date()) {
  if (!account?.dateOfBirth || account.archivedAt || account.isActive === false) return false;
  const dob = new Date(account.dateOfBirth);
  if (!Number.isFinite(+dob)) return false;
  const age = now.getUTCFullYear() - dob.getUTCFullYear() - (now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate()) ? 1 : 0);
  return age >= 18;
}
export const hasGuidance = (row, now = new Date()) => !!row && row.planType !== 'FREE' && ['TRIAL_72H', 'ACTIVE'].includes(row.planStatus) && row.planEndsAt > now;
export function paymentMatches(payment, order) { return payment.order_id === order.orderId && Number(payment.amount) === order.amountPaise && payment.currency === 'INR'; }
export function signatureMatches(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET).update(`${orderId}|${paymentId}`).digest();
  const supplied = Buffer.from(typeof signature === 'string' && /^[a-f\d]{64}$/i.test(signature) ? signature : '', 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}
async function locked(tx, userId) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(${userId}::bigint)`; }

// Queue the delivery in the same transaction as the payment, activation or
// refund. Booking-service deduplicates each operation after that commit.
function queueGymFulfillment(tx, order, action, payload) {
  return tx.coachingFulfillment.create({ data: {
    userId: order.userId,
    kind: GYM_ENTITLEMENT_SYNC,
    status: 'PENDING',
    idempotencyKey: `gym:${action}:${order.id}`,
    details: { action, payload },
  } });
}

async function activateV2Term(tx, order, startsAt, purchasedAt, now, hasExistingGym) {
  const offer = order.offerSnapshot;
  const trialEndsAt = offer.refundPolicy === 'self_serve_72h' ? new Date(+purchasedAt + 72 * HOUR) : null;
  const planEndsAt = new Date(+startsAt + offer.durationDays * DAY);
  const planStatus = planEndsAt <= now ? 'EXPIRED' : trialEndsAt > now ? 'TRIAL_72H' : 'ACTIVE';
  const data = {
    offerSnapshot: offer, planType: order.product, planStatus, trialEndsAt, planEndsAt, purchasedAt,
    activeOrderId: order.id, scheduledOrderId: null, hasExistingGym, freeDelightSessionsRemaining: 0, labCreditsRemaining: 0,
    gymPassStatus: offer.components.gym ? 'AWAITING_ASSIGNMENT' : 'NOT_INCLUDED',
    trainerSessionsRemaining: offer.components.trainer?.sessions ?? 0,
    nutritionistSessionsRemaining: offer.components.nutritionist?.sessions ?? 0,
  };
  const member = await tx.coachingMembership.upsert({ where: { userId: order.userId }, create: { userId: order.userId, ...data }, update: data });
  if (planStatus !== 'EXPIRED') {
    await tx.coachingFulfillment.create({ data: { userId: order.userId, kind: 'ONBOARDING', idempotencyKey: `onboarding:${order.id}`, details: { product: order.product, region: offer.region, city: offer.city } } });
    if (offer.components.gym && offer.region === 'GURUGRAM') {
      await queueGymFulfillment(tx, order, 'activate', {
        customerId: order.userId, orderRef: termOrderRef(order.id), offerKey: offer.key,
        startsAt: startsAt.toISOString(), endsAt: planEndsAt.toISOString(), region: offer.region,
        requiresClearance: offer.family === 'medical', source: order.isRenewal ? 'renewal' : 'purchase',
      });
    }
  }
  return member;
}

// Call under the user lock wherever a current term is needed.
async function currentMembership(tx, userId, now = new Date()) {
  const member = await tx.coachingMembership.findUnique({ where: { userId } });
  return activateScheduledTerm(tx, member, now);
}

async function activateScheduledTerm(tx, member, now) {
  if (!member?.scheduledOrderId || member.planEndsAt > now) return member;
  const order = await tx.coachingOrder.findUnique({ where: { id: member.scheduledOrderId } });
  if (order?.status !== 'SUCCESS' || order.termStartsAt > now) return member;
  return activateV2Term(tx, order, order.termStartsAt, order.fulfilledAt, now, member.hasExistingGym);
}

async function refreshMembership(userId) {
  const { member, activated } = await prisma.$transaction(async tx => {
    await locked(tx, userId);
    const now = new Date();
    const previous = await tx.coachingMembership.findUnique({ where: { userId } });
    const member = await activateScheduledTerm(tx, previous, now);
    const activated = member?.activeOrderId !== previous?.activeOrderId;
    if (!member || !['ACTIVE', 'TRIAL_72H'].includes(member.planStatus)) return { member, activated };
    const planStatus = member.planEndsAt <= now ? 'EXPIRED' : member.planStatus === 'TRIAL_72H' && member.trialEndsAt <= now ? 'ACTIVE' : member.planStatus;
    if (planStatus === member.planStatus) return { member, activated };
    await tx.coachingMembership.updateMany({ where: { userId }, data: { planStatus } });
    return { member: { ...member, planStatus }, activated };
  });
  if (activated) await retryGymFulfillment(userId).catch(logGymFulfillmentError);
  return member;
}
export async function guidanceContext(userId) {
  const url = process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';
  const res = await axios.get(`${url}/guidance/internal/${userId}`, { timeout: 15000, headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(url)) } });
  return res.data.data;
}
const requiresClearance = context => context?.clinicalStatus === 'NOT_CLEARED' ||
  (context?.riskBucket === 'RED' && context.clinicalStatus !== 'CLEARED');

async function medicalClearanceRequired(userId) {
  return guidanceContext(userId).then(requiresClearance, () => true);
}

async function coachingGymEntitlement({ action, payload }) {
  await axios.post(`${BOOKING_SERVICE_URL}${gymFulfillmentPaths[action]}`, payload, await bookingServiceOptions());
}

async function bookingServiceOptions() {
  return {
    timeout: 3000,
    headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(BOOKING_SERVICE_URL)) },
  };
}

async function bookingGymAddonRemaining(userId) {
  try {
    const response = await axios.get(`${BOOKING_SERVICE_URL}/internal/entitlements/${userId}`, await bookingServiceOptions());
    return response.data?.data?.addonRemaining ?? 0;
  } catch {
    return 0;
  }
}

function logGymFulfillmentError(error) {
  console.error('Could not sync coaching gym fulfillment', error.code || error.response?.status || error.name);
}

export async function retryGymFulfillment(userId) {
  const rows = await prisma.coachingFulfillment.findMany({
    where: { kind: GYM_ENTITLEMENT_SYNC, status: 'PENDING', ...(userId ? { userId } : {}) },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 50,
  });
  await Promise.all(rows.map(async row => {
    const where = { id: row.id, status: 'PENDING' };
    try {
      await coachingGymEntitlement(row.details);
      await prisma.coachingFulfillment.updateMany({ where, data: { status: 'COMPLETED' } });
    } catch (error) {
      logGymFulfillmentError(error);
      await prisma.coachingFulfillment.updateMany({ where, data: { updatedAt: new Date() } });
    }
  }));
}
export async function notifyCoachingFulfillment(userId) {
  const url = process.env.COACHING_FULFILLMENT_WEBHOOK_URL;
  const secret = process.env.COACHING_FULFILLMENT_WEBHOOK_SECRET;
  if (!url || !secret) return;
  const rows = await prisma.coachingFulfillment.findMany({ where: { notificationDeliveredAt: null, status: 'REQUESTED', ...(userId ? { userId } : {}) }, orderBy: { createdAt: 'asc' }, take: 50 });
  for (const row of rows) {
    if (!eligibleCoachingAccount(await coachingAccount(row.userId))) {
      await prisma.coachingFulfillment.update({ where: { id: row.id }, data: { status: 'CANCELLED' } });
      continue;
    }
    const body = JSON.stringify({ eventId: `coaching-fulfillment-${row.id}`, userId: row.userId, kind: row.kind });
    await axios.post(url, body, { timeout: 10000, headers: { 'Content-Type': 'application/json', 'x-coaching-signature': crypto.createHmac('sha256', secret).update(body).digest('hex') } });
    await prisma.coachingFulfillment.update({ where: { id: row.id }, data: { notificationDeliveredAt: new Date() } });
  }
}
export async function membershipView(userId, { includeGymBalance = true } = {}) {
  const row = await refreshMembership(userId), now = new Date();
  const account = row ? await coachingAccount(userId).catch(() => null) : null;
  if (row && account) {
    if (account.archivedAt || account.isActive === false) {
      await prisma.coachingMembership.update({ where: { userId }, data: { planStatus: 'INACTIVE', gymPassStatus: 'CANCELLED' } });
      row.planStatus = 'INACTIVE'; row.gymPassStatus = 'CANCELLED';
    }
    const hasExistingGym = !!(account.linkedGymId || account.homeUnclaimedGymId || (account.currentlyWorksOut && account.trainingLocationPref === 'gym'));
    if (row.hasExistingGym !== hasExistingGym) {
      await prisma.coachingMembership.update({ where: { userId }, data: { hasExistingGym } });
      row.hasExistingGym = hasExistingGym;
    }
  }
  const grants = await prisma.coachingAddonGrant.findMany({ where: { userId, expiresAt: { gt: now }, remaining: { gt: 0 } }, orderBy: { expiresAt: 'asc' } });
  const addonOffer = hasGuidance(row) && membershipBenefits(row).trainerFloorSessions ? trainerAddonOffer((await getCoachingConfig()).config) : null;
  const v2 = isV2(row?.offerSnapshot), guided = hasGuidance(row, now);
  const renewal = row?.scheduledOrderId ? await prisma.coachingOrder.findUnique({ where: { id: row.scheduledOrderId } }) : null;
  return {
    trainer_addon: addonOffer, free_delight_sessions_total: row?.offerSnapshot?.freeFormSessions ?? (!v2 && row?.planType && row.planType !== 'FREE' ? 2 : 0),
    region: row?.offerSnapshot?.region || (row ? 'GURUGRAM' : null), service_city: row?.offerSnapshot?.city || null,
    benefits: membershipBenefits(row), offer: row?.offerSnapshot || {}, membership_order_id: row?.activeOrderId || null,
    purchased_at: row?.purchasedAt || null, plan_type: row?.planType || 'FREE', plan_status: row?.planStatus || 'INACTIVE',
    trial_ends_at: row?.trialEndsAt || null, plan_ends_at: row?.planEndsAt || null, isGuided: guided,
    has_existing_gym: row?.hasExistingGym || false, free_delight_sessions_remaining: row?.freeDelightSessionsRemaining || 0,
    addon_trainer_sessions_remaining: grants.reduce((a, g) => a + g.remaining, 0), addon_grants: grants.map(g => ({ remaining: g.remaining, expires_at: g.expiresAt })),
    lab_credits_remaining: row?.labCreditsRemaining || 0, gym_pass_status: row?.gymPassStatus || 'NOT_ISSUED',
    trial_cleared: !!row?.trialEndsAt && row.trialEndsAt <= now,
    trainer_sessions_remaining: guided ? row.trainerSessionsRemaining ?? 0 : 0,
    nutritionist_sessions_remaining: guided ? row.nutritionistSessionsRemaining ?? 0 : 0,
    gym_sessions_remaining: includeGymBalance && guided && v2 && row.offerSnapshot.region === 'GURUGRAM'
      ? await bookingGymAddonRemaining(userId) : 0,
    clearanceRequired: guided && v2 && row.offerSnapshot.family === 'medical' && await medicalClearanceRequired(userId),
    scheduled_renewal: renewal ? { product: renewal.product, orderId: renewal.orderId, startsAt: renewal.termStartsAt, status: renewal.status } : null,
    fulfillment: await prisma.coachingFulfillment.findMany({ where: { userId, kind: { not: GYM_ENTITLEMENT_SYNC } }, orderBy: { createdAt: 'desc' }, take: 30 }),
  };
}

function validateV2Addon(member, offer, now) {
  if (!hasGuidance(member, now)) fail('An active guided plan is required', 403);
  if (!offer.families.includes(member.offerSnapshot?.family)) fail('This add-on is unavailable with your current plan', 403);
  if (member.offerSnapshot.region !== offer.region) fail('Choose an add-on in your current plan region', 403);
}

function v2CheckoutTerm(member, offer, now) {
  if (offer.kind) {
    validateV2Addon(member, offer, now);
    return { isRenewal: false, termStartsAt: null };
  }
  if (member?.scheduledOrderId) fail('You already have a scheduled renewal', 409);
  if (hasGuidance(member, now)) {
    if (+member.planEndsAt - +now > 7 * DAY) fail('You can renew in the last 7 days of your current plan', 409);
    return { isRenewal: true, termStartsAt: member.planEndsAt };
  }
  return { isRenewal: !!member?.activeOrderId && member.planStatus === 'EXPIRED', termStartsAt: null };
}

async function prepareV2Checkout(userId, product, selection, member) {
  const offer = await loadCoachingOfferV2(product, selection.city, selection.offerId);
  const term = v2CheckoutTerm(member, offer, new Date());
  const { statedCondition } = selection;
  if (statedCondition !== undefined && !['diabetes', 'prediabetes'].includes(statedCondition)) fail('Choose diabetes or prediabetes');
  if (offer.family === 'medical' && !statedCondition && !(await guidanceContext(userId))?.hasUploadedReport) {
    fail('Upload a report or state diabetes or prediabetes to choose a medical plan', 403);
  }
  const code = requestedCouponCode(selection.couponCode, !!offer.kind);
  const coupon = await loadCoachingCoupon(prisma, code);
  const price = priceCoachingV2Order(offer, selection, member?.offerSnapshot?.family, coupon, new Date());
  checkExpectedAmount(selection, price.amountPaise);
  const offerSnapshot = { ...offer, city: selection.city.trim(), membershipOrderId: member?.activeOrderId ?? null, price };
  return { offerSnapshot, price, term, coupon };
}

function checkExpectedAmount(selection, amountPaise) {
  if (selection.expectedAmountPaise !== undefined && selection.expectedAmountPaise !== amountPaise) {
    fail('The checkout price changed. Review the total and try again.', 409);
  }
}

async function requireAdultCheckout(userId) {
  if (!eligibleCoachingAccount(await coachingAccount(userId))) fail('Add your exact date of birth in your profile. Guided health support is available to adults aged 18 and over.', 403);
}

export function quoteCoachingOrder(product, selection, userId) {
  return withCouponTelemetry(userId, () => quoteOrder(product, selection, userId));
}

async function checkAvailableCoupon(coupon, userId) {
  if (coupon && !await couponHasCapacity(prisma, coupon, userId, { quote: true })) {
    rejectCoupon(coupon.code, 'limit_reached');
  }
}

async function quoteOrder(product, selection, userId) {
  if (isV2Product(product)) {
    await requireAdultCheckout(userId);
    const { offerSnapshot: offer, price, term, coupon } = await prepareV2Checkout(userId, product, selection, await refreshMembership(userId));
    await checkAvailableCoupon(coupon, userId);
    trackCoachingEvent(() => track('offer_quote_created', userId, {
      offer_key: offer.key, region: offer.region, amount_paise: price.amountPaise,
      coupon_code: price.couponCode, addon_count: offer.kind ? price.quantity : 0,
    }));
    return { ...price, product, region: offer.region, isRenewal: term.isRenewal, termStartsAt: term.termStartsAt };
  }
  const offer = await loadCoachingOffer(product, selection.city, selection.offerId);
  const coupon = await loadCoachingCoupon(prisma, requestedCouponCode(selection.couponCode, false));
  const price = coachingPrice(offer, coupon, new Date());
  await checkAvailableCoupon(coupon, userId);
  return price;
}

export function createCoachingOrder(userId, product, selection = {}) {
  return withCouponTelemetry(userId, () => createOrder(userId, product, selection));
}

async function createOrder(userId, product, selection) {
  const v2 = isV2Product(product);
  await requireAdultCheckout(userId);
  const row = await refreshMembership(userId);
  const legacyAddon = product === 'TRAINER_ADDON_1499';
  if (legacyAddon && !hasGuidance(row)) fail('An active guided plan is required', 403);
  if (legacyAddon && !membershipBenefits(row).trainerFloorSessions) fail('Trainer floor sessions are only available with Gurugram bundles', 403);
  const prepared = v2 ? await prepareV2Checkout(userId, product, selection, row) : null;
  const offerSnapshot = prepared?.offerSnapshot ?? (legacyAddon
    ? await loadTrainerAddon(selection.offerId)
    : { ...await loadCoachingOffer(product, selection.city, selection.offerId), city: selection.city.trim() });
  const addon = legacyAddon || !!offerSnapshot.kind;
  const coupon = prepared ? prepared.coupon : await loadCoachingCoupon(prisma, requestedCouponCode(selection.couponCode, addon));
  const price = prepared?.price ?? coachingPrice(offerSnapshot, coupon, new Date());
  const term = prepared?.term;
  const { amountPaise } = price;
  if (!v2) {
    checkExpectedAmount(selection, amountPaise);
    if (price.couponCode) offerSnapshot.discount = price;
  }
  const matchesOffer = order => order?.offerSnapshot?.offerId === offerSnapshot.offerId &&
    order?.offerSnapshot?.region === offerSnapshot.region && order.amountPaise === amountPaise &&
    (!price.couponCode || !couponCheckoutExpired(order)) &&
    (v2 ? order.offerSnapshot.price?.couponCode === price.couponCode && order.offerSnapshot.price?.quantity === price.quantity &&
      order.offerSnapshot.membershipOrderId === offerSnapshot.membershipOrderId && order.isRenewal === term.isRenewal &&
      +order.termStartsAt === +term.termStartsAt : order.offerSnapshot.discount?.couponCode === price.couponCode);
  if (!v2 && !addon && (hasGuidance(row) || row?.scheduledOrderId)) fail('You already have an active or scheduled guided plan', 409);
  const pendingOrder = { where: { userId, product, status: 'PENDING' }, ...(price.couponCode && { include: includeCouponStatus }) };
  const existing = await prisma.coachingOrder.findFirst({ ...pendingOrder, orderBy: { createdAt: 'desc' } });
  const out = order => ({
    orderId: order.orderId, keyId: process.env.RAZORPAY_KEY_ID, amount: order.amountPaise / 100, currency: 'INR',
    product: order.product, title: order.offerSnapshot?.title || null, region: order.offerSnapshot?.region || 'GURUGRAM',
    ...(v2 && { ...order.offerSnapshot.price, isRenewal: order.isRenewal, termStartsAt: order.termStartsAt }),
  });
  if (existing && matchesOffer(existing)) return out(existing);
  await checkAvailableCoupon(coupon, userId);
  const rpOrder = await provider().orders.create({ amount: amountPaise, currency: 'INR', receipt: `coach-${userId}-${Date.now()}`, notes: { purpose: 'guided_coaching', userId: String(userId), product, region: offerSnapshot.region } });
  try {
    const created = await prisma.$transaction(async tx => {
      await locked(tx, userId);
      const current = await currentMembership(tx, userId);
      if (v2) {
        const currentTerm = v2CheckoutTerm(current, offerSnapshot, new Date());
        if ((current?.activeOrderId ?? null) !== offerSnapshot.membershipOrderId ||
          currentTerm.isRenewal !== term.isRenewal || +currentTerm.termStartsAt !== +term.termStartsAt) {
          fail('Your guided plan changed. Refresh before paying.', 409);
        }
      } else if (addon ? (!hasGuidance(current) || !membershipBenefits(current).trainerFloorSessions) : hasGuidance(current) || current?.scheduledOrderId) {
        fail('Your guided plan changed. Refresh before paying.', 409);
      }
      const same = await tx.coachingOrder.findFirst(pendingOrder);
      if (same && matchesOffer(same)) return { order: same, inserted: false };
      if (addon && same) await tx.coachingOrder.update({ where: { id: same.id }, data: { status: 'CANCELLED' } });
      if (!addon) {
        const cancelled = await tx.coachingOrder.updateManyAndReturn({
          where: { userId, status: 'PENDING', isAddon: false, product: { not: 'TRAINER_ADDON_1499' } },
          data: { status: 'CANCELLED' }, select: { orderId: true },
        });
        if (cancelled.length) await releaseCouponReservations(tx, cancelled.map(row => row.orderId));
      }
      const currentCoupon = await loadCoachingCoupon(tx, price.couponCode, { lock: true });
      if (currentCoupon) {
        const now = new Date();
        const currentPrice = v2 ? priceCoachingV2Order(offerSnapshot, selection, current?.offerSnapshot?.family, currentCoupon, now)
          : coachingPrice(offerSnapshot, currentCoupon, now);
        checkExpectedAmount({ expectedAmountPaise: amountPaise }, currentPrice.amountPaise);
        if (!await couponHasCapacity(tx, currentCoupon, userId)) rejectCoupon(currentCoupon.code, 'limit_reached');
      }
      const order = await tx.coachingOrder.create({ data: { userId, product, amountPaise, orderId: rpOrder.id, offerSnapshot, isAddon: addon, ...term } });
      if (currentCoupon) await tx.couponRedemption.create({ data: { couponId: currentCoupon.id, userId, orderId: order.orderId } });
      return { order, inserted: true };
    }, { isolationLevel: 'ReadCommitted' });
    if (created.inserted && price.couponCode) trackCoachingEvent(() => track('coupon_applied', userId, {
      coupon_code: price.couponCode, reason: 'applied',
    }));
    return out(created.order);
  } catch (e) {
    if (e.code !== 'P2002') throw e;
    const pending = await prisma.coachingOrder.findFirst(pendingOrder);
    if (!pending || !matchesOffer(pending)) throw e;
    return out(pending);
  }
}

export async function markCoachingPaymentFailed(orderId) {
  if (!orderId) return;
  const order = await prisma.coachingOrder.findUnique({ where: { orderId } });
  await closePendingCoachingOrder(order, 'FAILED');
}

function couponCheckoutExpired(order) {
  return order.couponRedemption?.status === 'reserved' &&
    Date.now() - order.createdAt >= COUPON_CHECKOUT_TTL_MS;
}

async function closePendingCoachingOrder(order, status) {
  if (order?.status !== 'PENDING') return;
  const { orderId, userId } = order;
  await prisma.$transaction(async tx => {
    await locked(tx, userId);
    const { count } = await tx.coachingOrder.updateMany({
      where: { orderId, status: 'PENDING' }, data: { status },
    });
    if (count) await releaseCouponReservations(tx, [orderId]);
  });
}

function v2PaymentEligible(order, member, now) {
  const offer = order.offerSnapshot;
  if (offer.membershipOrderId !== (member?.activeOrderId ?? null)) return false;
  if (offer.kind) {
    return hasGuidance(member, now) && offer.families.includes(member.offerSnapshot?.family) &&
      offer.region === member.offerSnapshot.region;
  }
  if (member?.scheduledOrderId) return false;
  if (!order.termStartsAt) return !hasGuidance(member, now);
  return +order.termStartsAt === +member?.planEndsAt && +now < +order.termStartsAt + offer.durationDays * DAY;
}

async function grantV2Addon(tx, order, member) {
  const offer = order.offerSnapshot;
  const { quantity } = offer.price;
  const balance = V2_ADDON_BALANCES[offer.kind];
  if (offer.kind === 'gym_session') {
    await queueGymFulfillment(tx, order, 'addon', {
      customerId: order.userId, termOrderRef: termOrderRef(member.activeOrderId),
      idempotencyKey: `coaching-gym-addon-${order.id}`, sessions: quantity, expiresAt: member.planEndsAt.toISOString(),
    });
  } else if (balance) {
    await tx.coachingMembership.update({ where: { userId: order.userId }, data: { [balance]: { increment: quantity } } });
  } else {
    await tx.coachingFulfillment.create({ data: {
      userId: order.userId, kind: 'LAB_ADDON', idempotencyKey: `lab-addon:${order.id}`,
      details: { quantity, region: offer.region, availableAt: member.planEndsAt.toISOString(), membershipOrderId: member.activeOrderId },
    } });
  }
}

// Shared by client verification, the signed webhook and lazy reconciliation.
// All entitlement changes and the order claim commit in one transaction.
export async function settleCoachingPayment(orderId, paymentId) {
  const order = await prisma.coachingOrder.findUnique({ where: { orderId } });
  if (!order) return false;
  if (order.status === 'SUCCESS') return true;
  if (['REFUNDED', 'REFUND_PENDING', 'REFUND_PROCESSING', 'DUPLICATE_REFUND'].includes(order.status)) return true;
  const razorpay = provider();
  let payment = await razorpay.payments.fetch(paymentId);
  if (!paymentMatches(payment, order)) fail('Payment does not match this order', 409);
  if (payment.status === 'authorized') {
    try { payment = await razorpay.payments.capture(paymentId, order.amountPaise, 'INR'); }
    catch (e) { payment = await razorpay.payments.fetch(paymentId); if (payment.status !== 'captured') throw e; }
  }
  if (paymentMatches(payment, order) && payment.status === 'failed') await markCoachingPaymentFailed(orderId);
  if (!paymentMatches(payment, order) || payment.status !== 'captured') fail('Payment has not completed yet. Your order will reconcile automatically.', 409);
  const account = await coachingAccount(order.userId);
  const settled = await prisma.$transaction(async tx => {
    await locked(tx, order.userId);
    const now = new Date();
    const currentOrder = await tx.coachingOrder.findUnique({ where: { orderId } });
    if (!['PENDING', 'FAILED', 'CANCELLED'].includes(currentOrder.status)) return;
    const member = await currentMembership(tx, order.userId, now);
    const offer = currentOrder.offerSnapshot, v2 = isV2(offer), legacyAddon = currentOrder.product === 'TRAINER_ADDON_1499';
    const eligible = v2 ? v2PaymentEligible(currentOrder, member, now)
      : legacyAddon ? hasGuidance(member, now) && membershipBenefits(member).trainerFloorSessions
        : !hasGuidance(member, now) && !member?.scheduledOrderId;
    // Delayed capture after another purchase or after the plan ends is refunded,
    // never silently discarded or used to reset somebody's current membership.
    if (!eligibleCoachingAccount(account, now) || currentOrder.status === 'CANCELLED' || !eligible ||
        !await redeemCoachingCoupon(tx, currentOrder)) {
      await tx.coachingOrder.update({ where: { id: order.id }, data: { status: 'DUPLICATE_REFUND', paymentId, refundRequestedAt: now } });
      if (offer?.price?.couponCode || offer?.discount?.couponCode) await releaseCouponReservations(tx, [orderId]);
      return;
    }
    const hasExistingGym = !!(account.linkedGymId || account.homeUnclaimedGymId || (account.currentlyWorksOut && account.trainingLocationPref === 'gym'));
    if (v2 && offer.kind) await grantV2Addon(tx, currentOrder, member);
    else if (v2 && currentOrder.termStartsAt > now) {
      await tx.coachingMembership.update({ where: { userId: order.userId }, data: { scheduledOrderId: order.id } });
    } else if (v2) {
      await activateV2Term(tx, currentOrder, currentOrder.termStartsAt ?? now, now, now, hasExistingGym);
    } else if (legacyAddon) await tx.coachingAddonGrant.create({ data: { userId: order.userId, orderId: order.id, remaining: offer?.sessions ?? 4, expiresAt: new Date(+now + (offer?.validityDays ?? 30) * DAY) } });
    else {
      const benefits = membershipBenefits({ planType: order.product, offerSnapshot: offer });
      const data = { offerSnapshot: offer || {}, planType: order.product, planStatus: 'TRIAL_72H', purchasedAt: now, trialEndsAt: new Date(+now + 72 * HOUR), planEndsAt: new Date(+now + (offer?.durationDays ?? (order.product === 'QUARTERLY_11999' ? 90 : 30)) * DAY), freeDelightSessionsRemaining: benefits.trainerFloorSessions ? (offer?.freeFormSessions ?? 2) : 0, labCreditsRemaining: benefits.doorstepLabs ? (offer?.labCredits ?? 2) : 0, activeOrderId: order.id, gymPassStatus: benefits.gymAccess ? 'AWAITING_ASSIGNMENT' : 'NOT_INCLUDED', hasExistingGym, ...emptyV2Balances };
      await tx.coachingMembership.upsert({ where: { userId: order.userId }, create: { userId: order.userId, ...data }, update: data });
      await tx.coachingFulfillment.create({ data: { userId: order.userId, kind: 'ONBOARDING', idempotencyKey: `onboarding:${order.id}`, details: { product: order.product, region: offer?.region || 'GURUGRAM', city: offer?.city || null } } });
    }
    await tx.coachingOrder.update({ where: { id: order.id }, data: { status: 'SUCCESS', paymentId, fulfilledAt: now } });
    return currentOrder;
  }, { isolationLevel: 'ReadCommitted' });
  if (isV2(settled?.offerSnapshot)) {
    const offer = settled.offerSnapshot;
    if (offer.kind) {
      trackCoachingEvent(() => track('addon_purchased', settled.userId, {
        addon_key: offer.key, quantity: offer.price.quantity, discount_pct: offer.price.discountPct,
      }));
    } else {
      trackCoachingEvent(() => track('offer_purchased', settled.userId, {
        offer_key: offer.key, family: offer.family, region: offer.region, amount_paise: settled.amountPaise,
        coupon_code: offer.price.couponCode, is_renewal: settled.isRenewal,
      }));
    }
  }
  const latest = await prisma.coachingOrder.findUnique({ where: { orderId } });
  if (latest.status === 'DUPLICATE_REFUND') await refundCoachingOrder(latest.id);
  if (isV2(settled?.offerSnapshot)) await retryGymFulfillment(order.userId).catch(logGymFulfillmentError);
  await notifyCoachingFulfillment(order.userId).catch(() => {});
  return true;
}
export async function reconcileCoaching(userId) {
  const pending = await prisma.coachingOrder.findMany({
    where: { userId, status: { in: ['PENDING', 'FAILED', 'CANCELLED', 'REFUND_PENDING', 'REFUND_PROCESSING', 'DUPLICATE_REFUND'] } },
    take: 10, orderBy: { updatedAt: 'asc' }, include: includeCouponStatus,
  });
  for (const order of pending) {
    if (order.status.includes('REFUND')) { await refundCoachingOrder(order.id); continue; }
    const { items = [] } = await provider().orders.fetchPayments(order.orderId);
    const paid = items.find(p => ['captured', 'authorized'].includes(p.status));
    if (paid) await settleCoachingPayment(order.orderId, paid.id);
    else if (order.status === 'PENDING' && items.length && items.every(p => p.status === 'failed')) {
      await closePendingCoachingOrder(order, 'FAILED');
    } else if (order.status === 'PENDING' && items.length === 0 && couponCheckoutExpired(order)) {
      await closePendingCoachingOrder(order, 'CANCELLED');
    } else {
      await prisma.coachingOrder.updateMany({ where: { id: order.id, status: { in: ['PENDING', 'FAILED', 'CANCELLED'] } }, data: { updatedAt: new Date() } });
    }
  }
}
export async function activateDueCoachingRenewals() {
  const due = await prisma.coachingMembership.findMany({
    where: { scheduledOrderId: { not: null }, planEndsAt: { lte: new Date() } },
    orderBy: { planEndsAt: 'asc' }, select: { userId: true }, take: 100,
  });
  for (const { userId } of due) await refreshMembership(userId);
}
export async function refundCoachingOrder(id) {
  const initial = await prisma.coachingOrder.findUnique({ where: { id } });
  if (!initial) return;
  const order = await prisma.$transaction(async tx => {
    await locked(tx, initial.userId);
    const current = await tx.coachingOrder.findUnique({ where: { id } });
    if (current.status === 'REFUNDED') return null;
    if (current.status === 'REFUND_PROCESSING' && new Date() - current.updatedAt < 120000) return null;
    if (!['REFUND_PENDING', 'DUPLICATE_REFUND', 'REFUND_PROCESSING'].includes(current.status)) fail('This order has no refund request');
    await tx.coachingOrder.update({ where: { id }, data: { status: 'REFUND_PROCESSING' } });
    return current;
  });
  if (!order) return;
  // receipt is stable; recover an accepted provider refund after a process dies.
  const razorpay = provider(), receipt = `coaching-refund-${order.id}`;
  let refund;
  try {
    const prior = await razorpay.payments.fetchMultipleRefund(order.paymentId);
    const existing = prior.items?.find(r => r.receipt === receipt && r.status !== 'failed');
    refund = existing || await razorpay.payments.refund(order.paymentId, { amount: order.amountPaise, receipt, notes: { reason: '72_hour_guarantee_or_duplicate', coachingOrderId: String(order.id) } });
    if (refund.status === 'failed') fail('Refund was not accepted; your request is saved', 502);
  } catch (e) {
    await prisma.coachingOrder.updateMany({ where: { id, status: 'REFUND_PROCESSING' }, data: { status: 'REFUND_PENDING' } });
    throw e;
  }
  await prisma.$transaction(async tx => {
    await locked(tx, order.userId);
    const { count } = await tx.coachingOrder.updateMany({
      where: { id, status: { not: 'REFUNDED' } }, data: { refundId: refund.id, status: 'REFUNDED' },
    });
    if (!count) return;
    await tx.coachingMembership.updateMany({ where: { userId: order.userId, activeOrderId: id }, data: { planStatus: 'REFUNDED', freeDelightSessionsRemaining: 0, labCreditsRemaining: 0, gymPassStatus: 'CANCELLED', ...emptyV2Balances } });
    await tx.coachingMembership.updateMany({ where: { userId: order.userId, scheduledOrderId: id }, data: { scheduledOrderId: null } });
    if (isV2(order.offerSnapshot) && !order.offerSnapshot.kind) {
      await queueGymFulfillment(tx, order, 'cancel', { orderRef: termOrderRef(id) });
    }
  });
  if (isV2(order.offerSnapshot) && !order.offerSnapshot.kind) {
    await retryGymFulfillment(order.userId).catch(logGymFulfillmentError);
  }
}
export async function requestCoachingRefund(userId, orderId) {
  if (orderId !== undefined && (typeof orderId !== 'string' || !orderId)) fail('Choose a coaching order');
  const request = await prisma.$transaction(async tx => {
    await locked(tx, userId);
    const now = new Date();
    const member = await currentMembership(tx, userId, now);
    if (orderId === undefined && !member?.activeOrderId) fail('No guided purchase found');
    const order = await tx.coachingOrder.findUnique({ where: orderId === undefined ? { id: member.activeOrderId } : { orderId } });
    if (!order || order.userId !== userId || (order.id !== member?.activeOrderId && order.id !== member?.scheduledOrderId &&
      !(order.isRenewal && order.status === 'REFUNDED'))) fail('No guided purchase found', 404);
    const offer = order.offerSnapshot;
    if (isV2(offer) && offer.refundPolicy !== 'self_serve_72h') fail('Please contact support for a refund on this plan.', 409);
    if (order.status === 'REFUNDED') return null;
    const purchasedAt = order.fulfilledAt ?? member?.purchasedAt;
    const deadline = isV2(offer) && purchasedAt ? new Date(+purchasedAt + 72 * HOUR) : member?.trialEndsAt;
    if (!order.refundRequestedAt && (!deadline || now > deadline)) fail('The 72-hour guarantee window has ended');
    if (order.refundRequestedAt) return { order };
    await tx.coachingOrder.update({ where: { id: order.id }, data: { refundRequestedAt: now, status: 'REFUND_PENDING' } });
    if (order.id === member?.activeOrderId) {
      await tx.coachingMembership.updateMany({ where: { userId, activeOrderId: order.id }, data: { planStatus: 'INACTIVE' } });
    }
    return { order, hoursSincePurchase: (+now - +purchasedAt) / HOUR };
  });
  if (request) {
    const offer = request.order.offerSnapshot;
    if (isV2(offer) && request.hoursSincePurchase !== undefined) {
      trackCoachingEvent(() => track('offer_refund_requested', userId, {
        offer_key: offer.key, family: offer.family, hours_since_purchase: request.hoursSincePurchase,
      }));
    }
    await refundCoachingOrder(request.order.id);
  }
  return { refundRequested: true, message: 'Your full refund has been requested to the original payment method.' };
}
export async function requestLab(userId, address, idempotencyKey) {
  if (!eligibleCoachingAccount(await coachingAccount(userId))) fail('An active adult account is required', 403);
  if (typeof address !== 'string' || address.trim().length < 10 || address.length > 500) fail('Enter your full collection address');
  if (typeof idempotencyKey !== 'string' || !/^[\w-]{8,100}$/.test(idempotencyKey)) fail('A request identifier is required');
  const now = new Date();
  return prisma.$transaction(async tx => {
    await locked(tx, userId);
    const prior = await tx.coachingFulfillment.findUnique({ where: { idempotencyKey: `lab:${userId}:${idempotencyKey}` } });
    if (prior) return prior;
    const m = await tx.coachingMembership.findUnique({ where: { userId } });
    if (!hasGuidance(m) || !membershipBenefits(m).doorstepLabs || !m.trialEndsAt || now < m.trialEndsAt || m.labCreditsRemaining < 1) fail('An included panel is not available yet', 409);
    const existing = await tx.coachingFulfillment.findFirst({ where: { userId, kind: 'LAB', status: { in: ['REQUESTED', 'CONFIRMED'] }, ...(m.activeOrderId ? { details: { path: ['membershipOrderId'], equals: m.activeOrderId } } : {}) } });
    if (existing) return existing;
    // The second included panel is the re-test, not a second immediate baseline.
    const includedPanels = m.offerSnapshot?.labCredits ?? 2;
    const isRetest = m.labCreditsRemaining < includedPanels;
    if (isRetest && now < new Date(m.purchasedAt.getTime() + 89 * DAY)) fail('Your second panel becomes available on Day 90', 409);
    await tx.coachingMembership.update({ where: { userId }, data: { labCreditsRemaining: { decrement: 1 } } });
    return tx.coachingFulfillment.create({ data: { userId, kind: 'LAB', idempotencyKey: `lab:${userId}:${idempotencyKey}`, details: { address: address.trim(), panel: isRetest ? 'RETEST' : 'BASELINE', membershipOrderId: m.activeOrderId } } });
  });
}
export async function consumeSession(userId, kind, actor, key) {
  if (!eligibleCoachingAccount(await coachingAccount(userId))) fail('An active adult account is required', 403);
  const v2Balance = sessionBalances.get(kind);
  if ((!v2Balance && !['FREE_SESSION', 'ADDON_SESSION'].includes(kind)) || typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key)) fail('Choose a session and request identifier');
  if (!v2Balance && requiresClearance(await guidanceContext(userId))) fail('Clinical clearance is required before guided gym sessions', 409);
  const assessed = kind === 'TRAINER_SESSION' ? await refreshMembership(userId) : null;
  const blocked = assessed?.offerSnapshot?.family === 'medical' && await medicalClearanceRequired(userId);
  return prisma.$transaction(async tx => {
    await locked(tx, userId);
    const idempotencyKey = `session:${userId}:${key}`;
    const prior = await tx.coachingFulfillment.findUnique({ where: { idempotencyKey } });
    if (prior) return prior;
    const member = await currentMembership(tx, userId);
    if (!hasGuidance(member)) fail('The guided plan is not active', 409);
    if (v2Balance) {
      if (kind === 'TRAINER_SESSION' && member.offerSnapshot?.family === 'medical' &&
        (blocked || assessed?.activeOrderId !== member.activeOrderId)) fail('Clinical clearance is required before trainer sessions', 409);
      if (!(member[v2Balance] > 0)) fail('No sessions of this kind remain', 409);
      await tx.coachingMembership.update({ where: { userId }, data: { [v2Balance]: { decrement: 1 } } });
      return tx.coachingFulfillment.create({ data: { userId, kind, status: 'COMPLETED', completedBy: actor, idempotencyKey } });
    }
    if (!membershipBenefits(member).trainerFloorSessions) fail('Trainer floor sessions are not included in this regional plan', 403);
    if (kind === 'FREE_SESSION') {
      if (member.freeDelightSessionsRemaining < 1) fail('No free sessions remain', 409);
      await tx.coachingMembership.update({ where: { userId }, data: { freeDelightSessionsRemaining: { decrement: 1 } } });
    } else {
      const grant = await tx.coachingAddonGrant.findFirst({ where: { userId, expiresAt: { gt: new Date() }, remaining: { gt: 0 } }, orderBy: { expiresAt: 'asc' } });
      if (!grant) fail('No unexpired add-on sessions remain', 409);
      await tx.coachingAddonGrant.update({ where: { id: grant.id }, data: { remaining: { decrement: 1 } } });
    }
    return tx.coachingFulfillment.create({ data: { userId, kind, status: 'COMPLETED', completedBy: actor, idempotencyKey } });
  });
}
