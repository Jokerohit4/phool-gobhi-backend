import { Router } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import prisma from '../db/prisma.js';
import { membershipBenefits } from '../services/coachingCatalog.js';
import { loadCoachingCatalog, loadCoachingCatalogV2 } from '../services/coachingOfferService.js';
import { getCoachingConfig, saveCoachingConfig, coachingConfigHistory } from '../services/coachingConfigService.js';
import { createCoachingCoupon, listCoachingCoupons, updateCoachingCoupon } from '../services/coachingCouponAdmin.js';
import { errorBody } from '../utils/configConcurrency.js';
import { requireRole, requireInternal } from '../middleware/requireAuth.js';
import { membershipView, createCoachingOrder, quoteCoachingOrder, signatureMatches, settleCoachingPayment, markCoachingPaymentFailed, reconcileCoaching, activateDueCoachingRenewals, requestCoachingRefund, requestLab, consumeSession, guidanceContext, notifyCoachingFulfillment, retryGymFulfillment, GYM_ENTITLEMENT_SYNC } from '../services/coachingService.js';
const router = Router();
const run = fn => async (req, res) => {
  try { res.json({ data: await fn(req) }); }
  catch (e) {
    const body = e.status && e.status < 500 ? errorBody(e) : { error: 'Could not complete this request right now. Please try again.' };
    res.status(e.status || 500).json(body);
  }
};
router.get('/mine', requireRole('customer'), run(async req => {
  // Provider failure must not hide an already granted membership. Pending
  // payments remain visible and can be reconciled on the next read/webhook.
  let reconciliationPending = false;
  await reconcileCoaching(req.userId).catch(() => { reconciliationPending = true; });
  return { ...(await membershipView(req.userId)), reconciliationPending };
}));
router.put('/mine', requireRole('customer'), run(async req => {
  if (typeof req.body.hasExistingGym !== 'boolean') throw Object.assign(new Error('Choose whether you already have a gym'), { status: 400 });
  await prisma.coachingMembership.upsert({ where: { userId: req.userId }, create: { userId: req.userId, hasExistingGym: req.body.hasExistingGym }, update: { hasExistingGym: req.body.hasExistingGym } });
  return membershipView(req.userId);
}));
router.get('/catalog', requireRole('customer'), run(req => loadCoachingCatalog(req.query.city)));
router.get('/catalog/v2', requireRole('customer'), run(req => loadCoachingCatalogV2(req.query.city)));
router.get('/admin/config', requireRole('gobhi'), run(async () => ({ ...(await getCoachingConfig()), history: await coachingConfigHistory() })));
router.put('/admin/config', requireRole('gobhi'), run(req => saveCoachingConfig(req.body.config, req.body.expectedVersion, req.userId)));
router.get('/admin/coupons', requireRole('gobhi'), run(() => listCoachingCoupons()));
router.post('/admin/coupons', requireRole('gobhi'), run(req => createCoachingCoupon(req.body ?? {}, req.userId)));
router.patch('/admin/coupons/:code', requireRole('gobhi'), run(req => updateCoachingCoupon(req.params.code, req.body ?? {}, req.userId)));
router.post('/orders', requireRole('customer'), run(req => {
  const { product, city, offerId, couponCode, expectedAmountPaise, quoteOnly, quantity, statedCondition } = req.body;
  const selection = { city, offerId, couponCode, expectedAmountPaise, quantity, statedCondition };
  return quoteOnly === true ? quoteCoachingOrder(product, selection, req.userId) : createCoachingOrder(req.userId, product, selection);
}));
router.post('/verify', requireRole('customer'), run(async req => {
  const { orderId, razorpayPaymentId, razorpaySignature } = req.body;
  if (typeof orderId !== 'string' || typeof razorpayPaymentId !== 'string') throw Object.assign(new Error('Payment identifiers are required'), { status: 400 });
  const row = await prisma.coachingOrder.findUnique({ where: { orderId } });
  if (!row || row.userId !== req.userId) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (!signatureMatches(orderId, razorpayPaymentId, razorpaySignature)) throw Object.assign(new Error('Invalid payment signature'), { status: 400 });
  await settleCoachingPayment(orderId, razorpayPaymentId);
  const settled = await prisma.coachingOrder.findUnique({ where: { orderId } });
  return { ...(await membershipView(req.userId)), payment_status: settled.status };
}));
router.post('/refund', requireRole('customer'), run(req => requestCoachingRefund(req.userId, req.body?.orderId)));
router.post('/labs', requireRole('customer'), run(async req => {
  const record = await requestLab(req.userId, req.body.address, req.body.idempotencyKey);
  await notifyCoachingFulfillment(req.userId).catch(() => {});
  return record;
}));
router.get('/internal/:userId', requireInternal, run(req => membershipView(Number(req.params.userId), { includeGymBalance: false })));
router.post('/internal/reconcile', requireInternal, run(async () => {
  await activateDueCoachingRenewals();
  await retryGymFulfillment();
  const users = await prisma.coachingOrder.findMany({ where: { status: { in: ['PENDING', 'FAILED', 'CANCELLED', 'REFUND_PENDING', 'REFUND_PROCESSING', 'DUPLICATE_REFUND'] } }, select: { userId: true }, distinct: ['userId'], orderBy: { updatedAt: 'asc' }, take: 100 });
  let reconciled = 0;
  for (const { userId } of users) { await reconcileCoaching(userId); reconciled++; }
  await notifyCoachingFulfillment();
  return { reconciled };
}));
router.get('/admin/fulfillment', requireRole('gobhi'), run(async () => {
  const users = await prisma.coachingMembership.findMany({ where: { planType: { not: 'FREE' } }, orderBy: { updatedAt: 'desc' }, take: 200 });
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
  const info = new Map();
  if (users.length) {
    const response = await axios.post(`${authUrl}/internal/users/batch`, { ids: users.map(r => r.userId) }, { timeout: 15000, headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(authUrl)) } });
    for (const user of response.data?.data || []) info.set(user.id, user);
  }
  return Promise.all(users.map(async row => {
    const context = await guidanceContext(row.userId);
    return { id: row.userId, name: info.get(row.userId)?.name || context?.confirmedDetails?.name || 'Customer', phone: info.get(row.userId)?.phone || '', risk_bucket: context?.riskBucket || 'UNSET', clinical_status: context?.clinicalStatus || 'PENDING', ...(await membershipView(row.userId)) };
  }));
}));
router.post('/admin/fulfillment/:userId/sessions', requireRole('gobhi'), run(req => consumeSession(Number(req.params.userId), req.body.kind, req.userId, req.body.idempotencyKey)));
router.patch('/admin/fulfillment/:userId/gym', requireRole('gobhi'), run(async req => {
  const member = await prisma.coachingMembership.findUnique({ where: { userId: Number(req.params.userId) } });
  if (!member || !membershipBenefits(member).gymAccess) throw Object.assign(new Error('Gym access is not included in this regional plan'), { status: 409 });
  if (!['AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACTIVE', 'CANCELLED'].includes(req.body.status)) throw Object.assign(new Error('Choose a gym pass status'), { status: 400 });
  return prisma.coachingMembership.update({ where: { userId: Number(req.params.userId) }, data: { gymPassStatus: req.body.status } });
}));
router.patch('/admin/requests/:id', requireRole('gobhi'), run(async req => {
  if (!['CONFIRMED', 'COMPLETED', 'CANCELLED'].includes(req.body.status)) throw Object.assign(new Error('Choose a fulfillment status'), { status: 400 });
  return prisma.$transaction(async tx => {
    const row = await tx.coachingFulfillment.findUnique({ where: { id: Number(req.params.id) } });
    if (!row || row.kind === GYM_ENTITLEMENT_SYNC) throw Object.assign(new Error('Request not found'), { status: 404 });
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${row.userId}::bigint)`;
    const current = await tx.coachingFulfillment.findUnique({ where: { id: row.id } });
    if (current.status === 'CANCELLED' || current.status === 'COMPLETED') return current;
    if (current.kind === 'LAB' && req.body.status === 'CANCELLED') {
      const member = await tx.coachingMembership.findUnique({ where: { userId: row.userId } });
      const includedPanels = member?.offerSnapshot?.labCredits ?? 2;
      await tx.coachingMembership.updateMany({ where: { userId: row.userId, activeOrderId: current.details?.membershipOrderId ?? null, planStatus: { in: ['TRIAL_72H', 'ACTIVE'] }, labCreditsRemaining: { lt: includedPanels } }, data: { labCreditsRemaining: { increment: 1 } } });
    }
    return tx.coachingFulfillment.update({ where: { id: row.id }, data: { status: req.body.status, completedBy: req.userId } });
  });
}));
// Alternate webhook URL for dedicated provider configuration. The shared
// /webhooks/razorpay endpoint dispatches coaching orders to the same settler.
router.post('/webhook', run(async req => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const expected = secret && crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  const supplied = String(req.headers['x-razorpay-signature'] || '');
  if (!expected || !/^[a-f\d]{64}$/i.test(supplied) || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) throw Object.assign(new Error('Invalid webhook signature'), { status: 400 });
  const payment = req.body.payload?.payment?.entity;
  if (['payment.authorized', 'payment.captured'].includes(req.body.event) && payment?.order_id) await settleCoachingPayment(payment.order_id, payment.id);
  if (req.body.event === 'payment.failed') await markCoachingPaymentFailed(payment?.order_id);
  return { received: true };
}));
export default router;
