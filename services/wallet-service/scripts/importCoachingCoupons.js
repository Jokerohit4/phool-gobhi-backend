import { pathToFileURL } from 'node:url';
import { normalizeCouponCode } from '../services/coachingCoupons.js';

export async function importCoachingCoupons(db, raw = process.env.COACHING_COUPONS_JSON) {
  const entries = JSON.parse(raw || '{}');
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('COACHING_COUPONS_JSON must be an object keyed by coupon code');
  }
  const coupons = [];
  let skipped = 0;
  for (const [code, entry] of Object.entries(entries)) {
    const { percentOff, products, expiresAt } = entry ?? {};
    const activeTo = expiresAt ? new Date(Date.parse(expiresAt)) : null;
    if (normalizeCouponCode(code) !== code || !Number.isInteger(percentOff) || percentOff < 1 || percentOff > 99 ||
        (products != null && !Array.isArray(products)) || (activeTo && !Number.isFinite(+activeTo))) {
      skipped++;
      continue;
    }
    const offerKeys = products?.filter(key => typeof key === 'string');
    coupons.push({ code, kind: 'percent', value: percentOff, activeTo, offerKeys });
  }
  await db.$transaction(async tx => {
    for (const coupon of coupons) {
      // A rerun preserves any edits or disables made by the coupon owner.
      await tx.coupon.upsert({ where: { code: coupon.code }, create: coupon, update: {} });
    }
  });
  return { processed: coupons.length, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: prisma } = await import('../db/prisma.js');
  try {
    const { processed, skipped } = await importCoachingCoupons(prisma);
    console.log(`Processed ${processed} legacy coupons. Skipped ${skipped} invalid entries.`);
  } catch (error) {
    console.error('Legacy coupon import failed:', error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
