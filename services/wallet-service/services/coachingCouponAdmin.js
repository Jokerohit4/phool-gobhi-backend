import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import { configConflictError, parseExpectedUpdatedAt } from '../utils/configConcurrency.js';
import { loadCoachingCoupon, normalizeCouponCode } from './coachingCoupons.js';

const MAX_INT = 2147483647;
const invalid = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const positiveInt = value => Number.isInteger(value) && value >= 1 && value <= MAX_INT;

function readDate(body, field) {
  if (body[field] == null) return null;
  const date = typeof body[field] === 'string' ? new Date(body[field]) : null;
  if (!date || !Number.isFinite(+date)) invalid(`${field} must be an ISO date string or null`);
  return date;
}

function couponFields(body, current = {}) {
  const { kind, value, enabled = true, offerKeys = null, maxRedemptions = null, perCustomerLimit = null } =
    { ...current, ...body };
  if (!['fixed', 'percent'].includes(kind) || !positiveInt(value) || (kind === 'percent' && value > 99)) {
    invalid('Choose a fixed amount in paise or a percent from 1 to 99');
  }
  if (offerKeys !== null && (!Array.isArray(offerKeys) ||
      offerKeys.some(key => typeof key !== 'string' || !key.trim() || key !== key.trim()))) {
    invalid('offerKeys must be an array of offer keys or null');
  }
  if (typeof enabled !== 'boolean') invalid('enabled must be a boolean');
  if ([maxRedemptions, perCustomerLimit].some(limit => limit !== null && !positiveInt(limit))) {
    invalid('Redemption limits must be positive integers or null');
  }
  const activeFrom = Object.hasOwn(body, 'activeFrom') ? readDate(body, 'activeFrom') : current.activeFrom ?? null;
  const activeTo = Object.hasOwn(body, 'activeTo') ? readDate(body, 'activeTo') : current.activeTo ?? null;
  if (activeFrom && activeTo && activeFrom >= activeTo) invalid('activeTo must be after activeFrom');
  return {
    kind, value, enabled, offerKeys: offerKeys === null ? Prisma.DbNull : [...new Set(offerKeys)],
    maxRedemptions, perCustomerLimit, activeFrom, activeTo,
  };
}

export async function listCoachingCoupons() {
  const [coupons, counts] = await prisma.$transaction([
    prisma.coupon.findMany({ orderBy: { code: 'asc' } }),
    prisma.couponRedemption.groupBy({ by: ['couponId', 'status'], _count: { _all: true } }),
  ], { isolationLevel: 'RepeatableRead' });
  const byCoupon = new Map(coupons.map(coupon => [coupon.id, { reserved: 0, redeemed: 0, released: 0 }]));
  for (const row of counts) byCoupon.get(row.couponId)[row.status] = row._count._all;
  return coupons.map(coupon => ({ ...coupon, redemptionCounts: byCoupon.get(coupon.id) }));
}

export async function createCoachingCoupon(body, userId) {
  const code = normalizeCouponCode(body.code);
  if (!code) invalid('Choose a coupon code with 1 to 32 letters, digits, underscores or hyphens');
  try {
    return await prisma.coupon.create({ data: { code, ...couponFields(body), updatedBy: userId } });
  } catch (error) {
    if (error.code === 'P2002') invalid('A coupon with this code already exists', 409);
    throw error;
  }
}

export async function updateCoachingCoupon(rawCode, body, userId) {
  const code = normalizeCouponCode(rawCode);
  if (!code) invalid('Coupon not found', 404);
  if (Object.hasOwn(body, 'code') && normalizeCouponCode(body.code) !== code) invalid('Coupon codes cannot be changed');
  const expected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  return prisma.$transaction(async tx => {
    let current;
    try { current = await loadCoachingCoupon(tx, code, { lock: true }); }
    catch (error) {
      if (error.couponReason === 'invalid') invalid('Coupon not found', 404);
      throw error;
    }
    if (expected && +current.updatedAt !== +expected) throw configConflictError(current.updatedAt);
    const updatedAt = new Date(Math.max(Date.now(), +current.updatedAt + 1));
    return tx.coupon.update({
      where: { code }, data: { ...couponFields(body, current), updatedBy: userId, updatedAt },
    });
  }, { isolationLevel: 'ReadCommitted' });
}
