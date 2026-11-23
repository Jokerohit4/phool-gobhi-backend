import crypto from 'crypto';
import Razorpay from 'razorpay';
import axios from 'axios';
import prisma from '../db/prisma.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { membershipBenefits, trainerAddonOffer } from './coachingCatalog.js';
import { loadCoachingOffer, loadTrainerAddon } from './coachingOfferService.js';
import { getCoachingConfig } from './coachingConfigService.js';
import { coachingPrice } from './coachingCoupons.js';

export const COACHING_PRODUCTS = Object.freeze({ MONTHLY_4499: 449900, QUARTERLY_11999: 1199900, TRAINER_ADDON_1499: 149900 });
const HOUR = 3600000, DAY = HOUR * 24;
const provider = () => new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });
export async function eraseCoachingPersonalData(userId) {
  await prisma.$transaction([
    prisma.coachingFulfillment.updateMany({ where: { userId }, data: { details: {}, status: 'CANCELLED' } }),
    prisma.coachingMembership.updateMany({ where: { userId }, data: { planStatus: 'INACTIVE', hasExistingGym: false, gymPassStatus: 'CANCELLED', freeDelightSessionsRemaining: 0, labCreditsRemaining: 0 } }),
    prisma.coachingAddonGrant.updateMany({ where: { userId }, data: { remaining: 0 } }),
    prisma.coachingSubscription.updateMany({ where: { userId }, data: { userName: null, phone: null, riskBucket: 'UNSET', worksOut: null, hasExistingGym: false, hasNutritionist: false } }),
  ]);
  return { erased: true, financialRecordsRetained: true };
}
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
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
async function refreshMembership(userId) {
  const now = new Date();
  await prisma.coachingMembership.updateMany({ where: { userId, planStatus: { in: ['ACTIVE', 'TRIAL_72H'] }, planEndsAt: { lte: now } }, data: { planStatus: 'EXPIRED' } });
  await prisma.coachingMembership.updateMany({ where: { userId, planStatus: 'TRIAL_72H', trialEndsAt: { lte: now }, planEndsAt: { gt: now } }, data: { planStatus: 'ACTIVE' } });
  return prisma.coachingMembership.findUnique({ where: { userId } });
}
export async function guidanceContext(userId) {
  const url = process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';
  const res = await axios.get(`${url}/guidance/internal/${userId}`, { timeout: 15000, headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(url)) } });
  return res.data.data;
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
export async function membershipView(userId) {
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
  return { trainer_addon: addonOffer, free_delight_sessions_total: row?.offerSnapshot?.freeFormSessions ?? (row?.planType && row.planType !== 'FREE' ? 2 : 0), region: row?.offerSnapshot?.region || (row ? 'GURUGRAM' : null), service_city: row?.offerSnapshot?.city || null, benefits: membershipBenefits(row), offer: row?.offerSnapshot || {}, membership_order_id: row?.activeOrderId || null, purchased_at: row?.purchasedAt || null, plan_type: row?.planType || 'FREE', plan_status: row?.planStatus || 'INACTIVE', trial_ends_at: row?.trialEndsAt || null, plan_ends_at: row?.planEndsAt || null, isGuided: hasGuidance(row, now), has_existing_gym: row?.hasExistingGym || false, free_delight_sessions_remaining: row?.freeDelightSessionsRemaining || 0, addon_trainer_sessions_remaining: grants.reduce((a, g) => a + g.remaining, 0), addon_grants: grants.map(g => ({ remaining: g.remaining, expires_at: g.expiresAt })), lab_credits_remaining: row?.labCreditsRemaining || 0, gym_pass_status: row?.gymPassStatus || 'NOT_ISSUED', trial_cleared: !!row?.trialEndsAt && row.trialEndsAt <= now, fulfillment: await prisma.coachingFulfillment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 30 }) };
}
export async function quoteCoachingOrder(product, selection) {
  const offer = await loadCoachingOffer(product, selection.city, selection.offerId);
  return coachingPrice(offer, selection.couponCode);
}

export async function createCoachingOrder(userId, product, selection = {}) {
  if (!Object.hasOwn(COACHING_PRODUCTS, product)) fail('Choose one of the two guided plans or trainer add-on');
  if (!eligibleCoachingAccount(await coachingAccount(userId))) fail('Add your exact date of birth in your profile. Guided health support is available to adults aged 18 and over.', 403);
  const row = await refreshMembership(userId), addon = product === 'TRAINER_ADDON_1499';
  if (addon && !hasGuidance(row)) fail('An active guided plan is required', 403);
  if (addon && !membershipBenefits(row).trainerFloorSessions) fail('Trainer floor sessions are only available with Gurugram bundles', 403);
  const offerSnapshot = addon ? await loadTrainerAddon(selection.offerId) : { ...await loadCoachingOffer(product, selection.city, selection.offerId), city: selection.city.trim() };
  const price = coachingPrice(offerSnapshot, selection.couponCode);
  const { amountPaise } = price;
  if (selection.expectedAmountPaise !== undefined && selection.expectedAmountPaise !== amountPaise) {
    fail('The checkout price changed. Review the total and try again.', 409);
  }
  if (price.couponCode) offerSnapshot.discount = price;
  const matchesOffer = order => order?.offerSnapshot?.offerId === offerSnapshot.offerId &&
    order?.offerSnapshot?.region === offerSnapshot.region && order.amountPaise === amountPaise &&
    order.offerSnapshot?.discount?.couponCode === price.couponCode;
  if (!addon && hasGuidance(row)) fail('You already have an active guided plan', 409);
  const existing = await prisma.coachingOrder.findFirst({ where: { userId, product, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
  const out = order => ({ orderId: order.orderId, keyId: process.env.RAZORPAY_KEY_ID, amount: order.amountPaise / 100, currency: 'INR', product: order.product, title: order.offerSnapshot?.title || null, region: order.offerSnapshot?.region || 'GURUGRAM' });
  if (existing && matchesOffer(existing)) return out(existing);
  const rpOrder = await provider().orders.create({ amount: amountPaise, currency: 'INR', receipt: `coach-${userId}-${Date.now()}`, notes: { purpose: 'guided_coaching', userId: String(userId), product, region: offerSnapshot.region } });
  try { return out(await prisma.$transaction(async tx => {
    await locked(tx, userId);
    const current = await tx.coachingMembership.findUnique({ where: { userId } });
    if (addon ? (!hasGuidance(current) || !membershipBenefits(current).trainerFloorSessions) : hasGuidance(current)) fail('Your guided plan changed. Refresh before paying.', 409);
    const same = await tx.coachingOrder.findFirst({ where: { userId, product, status: 'PENDING' } });
    if (same && matchesOffer(same)) return same;
    if (same) await tx.coachingOrder.update({ where: { id: same.id }, data: { status: 'CANCELLED' } });
    if (!addon) await tx.coachingOrder.updateMany({ where: { userId, status: 'PENDING', product: { not: 'TRAINER_ADDON_1499' } }, data: { status: 'CANCELLED' } });
    return tx.coachingOrder.create({ data: { userId, product, amountPaise, orderId: rpOrder.id, offerSnapshot } });
  })); }
  catch (e) {
    if (e.code !== 'P2002') throw e;
    const pending = await prisma.coachingOrder.findFirst({ where: { userId, product, status: 'PENDING' } });
    if (!pending || !matchesOffer(pending)) throw e;
    return out(pending);
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
  if (!paymentMatches(payment, order) || payment.status !== 'captured') fail('Payment has not completed yet. Your order will reconcile automatically.', 409);
  const now = new Date(), addon = order.product === 'TRAINER_ADDON_1499';
  const account = await coachingAccount(order.userId);
  await prisma.$transaction(async tx => {
    await locked(tx, order.userId);
    const currentOrder = await tx.coachingOrder.findUnique({ where: { orderId } });
    if (!['PENDING', 'FAILED', 'CANCELLED'].includes(currentOrder.status)) return;
    const member = await tx.coachingMembership.findUnique({ where: { userId: order.userId } });
    // Delayed capture after another purchase or after the plan ends is refunded,
    // never silently discarded or used to reset somebody's current membership.
    if (!eligibleCoachingAccount(account, now) || currentOrder.status === 'CANCELLED' || (addon ? (!hasGuidance(member, now) || !membershipBenefits(member).trainerFloorSessions) : hasGuidance(member, now))) {
      await tx.coachingOrder.update({ where: { id: order.id }, data: { status: 'DUPLICATE_REFUND', paymentId, refundRequestedAt: now } });
      return;
    }
    if (addon) await tx.coachingAddonGrant.create({ data: { userId: order.userId, orderId: order.id, remaining: order.offerSnapshot?.sessions ?? 4, expiresAt: new Date(now.getTime() + (order.offerSnapshot?.validityDays ?? 30) * DAY) } });
    else {
      const benefits = membershipBenefits({ planType: order.product, offerSnapshot: order.offerSnapshot });
      const data = { offerSnapshot: order.offerSnapshot || {}, planType: order.product, planStatus: 'TRIAL_72H', purchasedAt: now, trialEndsAt: new Date(now.getTime() + 72 * HOUR), planEndsAt: new Date(now.getTime() + (order.offerSnapshot?.durationDays ?? (order.product === 'QUARTERLY_11999' ? 90 : 30)) * DAY), freeDelightSessionsRemaining: benefits.trainerFloorSessions ? (order.offerSnapshot?.freeFormSessions ?? 2) : 0, labCreditsRemaining: benefits.doorstepLabs ? (order.offerSnapshot?.labCredits ?? 2) : 0, activeOrderId: order.id, gymPassStatus: benefits.gymAccess ? 'AWAITING_ASSIGNMENT' : 'NOT_INCLUDED', hasExistingGym: !!(account.linkedGymId || account.homeUnclaimedGymId || (account.currentlyWorksOut && account.trainingLocationPref === 'gym')) };
      await tx.coachingMembership.upsert({ where: { userId: order.userId }, create: { userId: order.userId, ...data }, update: data });
      await tx.coachingFulfillment.create({ data: { userId: order.userId, kind: 'ONBOARDING', idempotencyKey: `onboarding:${order.id}`, details: { product: order.product, region: order.offerSnapshot?.region || 'GURUGRAM', city: order.offerSnapshot?.city || null } } });
    }
    await tx.coachingOrder.update({ where: { id: order.id }, data: { status: 'SUCCESS', paymentId, fulfilledAt: now } });
  });
  const latest = await prisma.coachingOrder.findUnique({ where: { orderId } });
  if (latest.status === 'DUPLICATE_REFUND') await refundCoachingOrder(latest.id);
  await notifyCoachingFulfillment(order.userId).catch(() => {});
  return true;
}
export async function reconcileCoaching(userId) {
  const pending = await prisma.coachingOrder.findMany({ where: { userId, status: { in: ['PENDING', 'FAILED', 'CANCELLED', 'REFUND_PENDING', 'REFUND_PROCESSING', 'DUPLICATE_REFUND'] } }, take: 10, orderBy: { updatedAt: 'asc' } });
  for (const order of pending) {
    if (order.status.includes('REFUND')) { await refundCoachingOrder(order.id); continue; }
    const payments = await provider().orders.fetchPayments(order.orderId);
    const paid = payments.items?.find(p => ['captured', 'authorized'].includes(p.status));
    if (paid) await settleCoachingPayment(order.orderId, paid.id);
    else await prisma.coachingOrder.updateMany({ where: { id: order.id, status: { in: ['PENDING', 'FAILED', 'CANCELLED'] } }, data: { updatedAt: new Date() } });
  }
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
    await tx.coachingOrder.update({ where: { id }, data: { refundId: refund.id, status: 'REFUNDED' } });
    await tx.coachingMembership.updateMany({ where: { userId: order.userId, activeOrderId: id }, data: { planStatus: 'REFUNDED', freeDelightSessionsRemaining: 0, labCreditsRemaining: 0, gymPassStatus: 'CANCELLED' } });
  });
}
export async function requestCoachingRefund(userId) {
  const member = await prisma.coachingMembership.findUnique({ where: { userId } });
  if (!member?.activeOrderId) fail('No guided purchase found');
  const order = await prisma.coachingOrder.findUnique({ where: { id: member.activeOrderId } });
  if (!order.refundRequestedAt && (!member.trialEndsAt || new Date() > member.trialEndsAt)) fail('The 72-hour guarantee window has ended');
  if (order.status !== 'REFUNDED') {
    await prisma.coachingOrder.updateMany({ where: { id: order.id, status: { notIn: ['REFUNDED', 'REFUND_PROCESSING'] } }, data: { refundRequestedAt: order.refundRequestedAt || new Date(), status: 'REFUND_PENDING' } });
    // Disable new fulfillment as soon as the request is recorded.
    await prisma.coachingMembership.updateMany({ where: { userId, activeOrderId: order.id }, data: { planStatus: 'INACTIVE' } });
    await refundCoachingOrder(order.id);
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
  if (!['FREE_SESSION', 'ADDON_SESSION'].includes(kind) || typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key)) fail('Choose a session and request identifier');
  const context = await guidanceContext(userId);
  if (context?.clinicalStatus === 'NOT_CLEARED' || (context?.riskBucket === 'RED' && context.clinicalStatus !== 'CLEARED')) fail('Clinical clearance is required before guided gym sessions', 409);
  return prisma.$transaction(async tx => {
    await locked(tx, userId);
    const idempotencyKey = `session:${userId}:${key}`;
    const prior = await tx.coachingFulfillment.findUnique({ where: { idempotencyKey } });
    if (prior) return prior;
    const member = await tx.coachingMembership.findUnique({ where: { userId } });
    if (!hasGuidance(member)) fail('The guided plan is not active', 409);
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
