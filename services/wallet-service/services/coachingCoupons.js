// Configure via COACHING_COUPONS_JSON, keyed by uppercase coupon code.
export function coachingPrice(offer, couponCode) {
  const originalAmountPaise = offer.amountPaise;
  if (couponCode == null || couponCode === '') {
    return { originalAmountPaise, amountPaise: originalAmountPaise, discountPaise: 0 };
  }
  const invalid = () => {
    throw Object.assign(new Error('This coupon is invalid or unavailable for this plan.'), { status: 400 });
  };
  if (typeof couponCode !== 'string') invalid();
  const code = couponCode.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(code) || offer.product === 'TRAINER_ADDON_1499') invalid();
  const coupons = JSON.parse(process.env.COACHING_COUPONS_JSON || '{}');
  const coupon = Object.hasOwn(coupons, code) ? coupons[code] : null;
  if (!coupon || !Number.isInteger(coupon.percentOff) || coupon.percentOff < 1 ||
      coupon.percentOff > 99 || (coupon.products != null &&
        (!Array.isArray(coupon.products) || !coupon.products.includes(offer.product))) ||
      (coupon.expiresAt && !(Date.parse(coupon.expiresAt) > Date.now()))) invalid();
  const discountPaise = Math.floor(originalAmountPaise * coupon.percentOff / 100);
  const amountPaise = originalAmountPaise - discountPaise;
  if (discountPaise < 1 || amountPaise < 100) invalid();
  return { originalAmountPaise, amountPaise, discountPaise, couponCode: code };
}
