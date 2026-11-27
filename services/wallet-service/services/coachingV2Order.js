import { coachingPrice } from './coachingCoupons.js';
import { MAX_COACHING_ADDON_QUANTITY, MAX_COACHING_AMOUNT_PAISE } from './coachingV2Config.js';

export const V2_ADDON_BALANCES = {
  trainer_session: 'trainerSessionsRemaining',
  nutritionist_session: 'nutritionistSessionsRemaining',
};

export function priceCoachingV2Order(offer, selection, family) {
  const isAddon = !!offer.kind;
  const quantity = selection.quantity === undefined ? 1 : selection.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > (isAddon ? MAX_COACHING_ADDON_QUANTITY : 1)) {
    throw Object.assign(new Error('Choose a valid quantity'), { status: 400 });
  }
  const unitPaise = isAddon ? offer.unitPaise : offer.amountPaise;
  const listAmountPaise = unitPaise * quantity;
  if (listAmountPaise > MAX_COACHING_AMOUNT_PAISE) {
    throw Object.assign(new Error('Choose a lower quantity'), { status: 400 });
  }
  const qualifiesForTiers = !offer.volumeTierFamilies || offer.volumeTierFamilies.includes(family);
  const tiers = qualifiesForTiers ? offer.volumeTiers : null;
  const discountPct = tiers?.findLast(tier => quantity >= tier.minQty)?.discountPct ?? 0;
  const volumeDiscountPaise = Math.floor(listAmountPaise * discountPct / 100);
  const subtotalPaise = listAmountPaise - volumeDiscountPaise;
  if (subtotalPaise < 100) throw Object.assign(new Error('The checkout total must be at least one rupee'), { status: 400 });
  const { amountPaise, discountPaise: couponDiscountPaise, couponCode } = coachingPrice({
    product: offer.key, amountPaise: subtotalPaise,
  }, selection.couponCode);
  const lines = [{ type: 'list_price', key: offer.key, quantity, unitPaise, amountPaise: listAmountPaise }];
  if (volumeDiscountPaise) lines.push({ type: 'volume_discount', discountPct, amountPaise: -volumeDiscountPaise });
  if (couponDiscountPaise) lines.push({ type: 'coupon_discount', couponCode, amountPaise: -couponDiscountPaise });
  lines.push({ type: 'total', amountPaise });
  return {
    quantity, listAmountPaise, volumeDiscountPaise, discountPct, couponDiscountPaise, couponCode: couponCode ?? null, amountPaise, lines,
  };
}
