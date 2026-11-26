const CODE_PATTERN = /^[A-Z0-9_-]{1,32}$/;
const ACTIVE_STATUSES = ['reserved', 'redeemed'];

export function normalizeCouponCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

export function rejectCoupon(couponCode, couponReason) {
  throw Object.assign(new Error('This coupon is invalid or unavailable for this plan.'), {
    status: 400, couponCode, couponReason,
  });
}

export function requestedCouponCode(raw, isAddon) {
  if (raw == null || raw === '') return null;
  const code = normalizeCouponCode(raw);
  if (!code) rejectCoupon(null, 'invalid');
  if (isAddon) rejectCoupon(code, 'not_eligible');
  return code;
}

export async function loadCoachingCoupon(db, code, { lock = false } = {}) {
  if (!code) return null;
  if (lock) {
    const rows = await db.$queryRaw`SELECT "id" FROM "wallet"."Coupon" WHERE "code" = ${code} FOR UPDATE`;
    if (!rows.length) rejectCoupon(code, 'invalid');
  }
  const coupon = await db.coupon.findUnique({ where: { code } });
  if (!coupon) rejectCoupon(code, 'invalid');
  return coupon;
}

export function coachingPrice(offer, coupon, now) {
  const originalAmountPaise = offer.amountPaise;
  if (!coupon) return { originalAmountPaise, amountPaise: originalAmountPaise, discountPaise: 0 };
  const { code, enabled, activeFrom, activeTo, offerKeys, kind, value } = coupon;
  if (!enabled) rejectCoupon(code, 'disabled');
  if ((activeFrom && now < activeFrom) || (activeTo && now >= activeTo)) rejectCoupon(code, 'expired');
  if (offer.kind || offer.product === 'TRAINER_ADDON_1499' ||
      (offerKeys != null && !offerKeys.includes(offer.key ?? offer.product))) rejectCoupon(code, 'not_eligible');
  const discountPaise = kind === 'fixed'
    ? Math.min(value, originalAmountPaise - 100)
    : Math.floor(originalAmountPaise * value / 100);
  const amountPaise = originalAmountPaise - discountPaise;
  if (discountPaise < 1 || amountPaise < 100) rejectCoupon(code, 'not_eligible');
  return { originalAmountPaise, amountPaise, discountPaise, couponCode: code };
}

export async function couponHasCapacity(db, coupon, userId, { quote = false } = {}) {
  const { id: couponId, maxRedemptions, perCustomerLimit } = coupon;
  const where = { couponId, status: { in: ACTIVE_STATUSES } };
  // A quote can use the slot from the customer's own pending plan. Checkout
  // releases that reservation before counting again under the coupon row lock.
  if (quote && userId != null) where.NOT = { userId, status: 'reserved', order: { status: 'PENDING' } };
  if (maxRedemptions != null && await db.couponRedemption.count({ where }) >= maxRedemptions) return false;
  return perCustomerLimit == null || userId == null ||
    await db.couponRedemption.count({ where: { ...where, userId } }) < perCustomerLimit;
}

export function releaseCouponReservations(db, orderIds) {
  return db.couponRedemption.updateMany({
    where: { status: 'reserved', orderId: { in: orderIds } },
    data: { status: 'released' },
  });
}

export async function redeemCoachingCoupon(tx, order) {
  const code = order.offerSnapshot?.price?.couponCode ?? order.offerSnapshot?.discount?.couponCode;
  if (!code) return true;
  const redemption = await tx.couponRedemption.findUnique({ where: { orderId: order.orderId } });
  // Pending orders created before the coupon migration already have a price.
  if (!redemption || redemption.status === 'redeemed') return true;
  if (redemption.status === 'released') {
    const coupon = await loadCoachingCoupon(tx, code, { lock: true });
    if (!await couponHasCapacity(tx, coupon, order.userId)) return false;
  }
  await tx.couponRedemption.update({ where: { orderId: order.orderId }, data: { status: 'redeemed' } });
  return true;
}
