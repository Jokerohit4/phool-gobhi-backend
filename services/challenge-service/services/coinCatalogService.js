import { PrismaClient } from '@prisma/client';
import { creditCoinsService, debitCoinsService } from './coinLedgerService.js';
const prisma = new PrismaClient();

// Seeded once, only if the catalog is completely empty, so the feature isn't
// empty out of the box. Reuses the ratio the planning docs proposed for
// coin->wallet conversion ("500 coins -> Rs 50") — but reframed correctly as
// a subscription-purchase discount, never a cash credit, per this build's
// explicit override of that doc's decision. Admins are free to edit/retire/
// add more items from day one; this is a starting point, not a fixed rule.
const SEED_ITEM = {
  key: 'sub_discount_50',
  category: 'subscription_discount',
  title: 'Rs 50 off your next subscription',
  description: 'Redeemed automatically at checkout when you choose it while buying a gym subscription.',
  coinCost: 500,
  discountAmount: 50,
};

async function ensureSeeded() {
  const count = await prisma.coinCatalogItem.count();
  if (count === 0) {
    await prisma.coinCatalogItem.create({ data: SEED_ITEM });
  }
}

export async function listActiveCatalogService() {
  await ensureSeeded();
  return prisma.coinCatalogItem.findMany({ where: { isActive: true }, orderBy: { coinCost: 'asc' } });
}

export async function listCatalogAdminService() {
  await ensureSeeded();
  return prisma.coinCatalogItem.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function createCatalogItemAdminService({ key, category, title, description, coinCost, discountAmount, isActive }) {
  if (!key || !category || !title || !Number.isInteger(coinCost) || coinCost <= 0) {
    throw { status: 400, error: 'key, category, title and a positive integer coinCost are required' };
  }
  return prisma.coinCatalogItem.create({
    data: { key, category, title, description: description ?? null, coinCost, discountAmount: discountAmount ?? null, isActive: isActive ?? true },
  });
}

export async function updateCatalogItemAdminService(id, { title, description, coinCost, discountAmount, isActive }) {
  const existing = await prisma.coinCatalogItem.findUnique({ where: { id: Number(id) } });
  if (!existing) throw { status: 404, error: 'Catalog item not found' };
  return prisma.coinCatalogItem.update({
    where: { id: Number(id) },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(coinCost !== undefined ? { coinCost: Number(coinCost) } : {}),
      ...(discountAmount !== undefined ? { discountAmount: discountAmount === null ? null : Number(discountAmount) } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
    },
  });
}

// Called internally by wallet-service at subscription-purchase time (never
// directly by a customer) — debits coins and records the redemption in one
// step, since there's no separate "reservation" phase in this build. If the
// wallet-side purchase fails afterward, the caller must call
// refundRedemptionService with the returned redemptionId.
export async function redeemCatalogItemService({ userId, catalogItemKey, idempotencyKey, metadata }) {
  const item = await prisma.coinCatalogItem.findUnique({ where: { key: catalogItemKey } });
  if (!item || !item.isActive) throw { status: 404, error: 'Catalog item not found or inactive' };

  const existing = idempotencyKey
    ? await prisma.coinRedemption.findUnique({ where: { idempotencyKey } })
    : null;
  if (existing) return serializeRedemption(existing, item);

  // debitCoinsService throws 'Insufficient coins' if the balance can't cover
  // it — deliberately NOT caught here, so the caller (wallet-service) treats
  // it as a hard failure and aborts the purchase rather than silently
  // charging full price.
  await debitCoinsService(userId, item.coinCost, `Redeemed: ${item.title}`, idempotencyKey);

  const redemption = await prisma.coinRedemption.create({
    data: {
      userId,
      catalogItemId: item.id,
      coinCost: item.coinCost,
      status: 'fulfilled',
      metadata: metadata ?? null,
      idempotencyKey,
    },
  });
  return serializeRedemption(redemption, item);
}

// Reverses a redemption whose downstream fulfillment (the actual
// subscription purchase) failed after coins were already debited — credits
// the coins back and marks the row 'refunded'. Idempotent: a redemption
// already refunded is returned as-is rather than double-crediting.
export async function refundRedemptionService(redemptionId, idempotencyKey) {
  const redemption = await prisma.coinRedemption.findUnique({ where: { id: Number(redemptionId) } });
  if (!redemption) throw { status: 404, error: 'Redemption not found' };
  if (redemption.status === 'refunded') return redemption;

  await creditCoinsService(redemption.userId, redemption.coinCost, 'Refund: purchase did not complete', idempotencyKey);
  return prisma.coinRedemption.update({ where: { id: redemption.id }, data: { status: 'refunded' } });
}

function serializeRedemption(redemption, item) {
  return {
    redemptionId: redemption.id,
    coinCost: redemption.coinCost,
    status: redemption.status,
    discountAmount: item?.discountAmount ?? null,
    category: item?.category ?? null,
  };
}
