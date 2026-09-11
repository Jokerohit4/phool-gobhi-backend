import { PrismaClient, Prisma } from '@prisma/client';
import { creditCoinsService, debitCoinsService, debitCoinsInTx } from './coinLedgerService.js';
import { loadEconomyConfig } from './coinEconomyConfigService.js';
const prisma = new PrismaClient();

// Seeded once, only if the catalog is completely empty, so the feature isn't
// empty out of the box. Admins are free to edit/retire/add more items from
// day one; this is a starting point, not a fixed rule.
//
// sub_discount_50 reuses the ratio the planning docs proposed for
// coin->wallet conversion ("500 coins -> Rs 50") — but reframed correctly as
// a subscription-purchase discount, never a cash credit, per this build's
// explicit override of that doc's decision.
//
// buddy_boost_50 (D-03) is the cheapest thing in the catalog, on purpose:
// a full QR-hunt chain pays 90 coins, and if nothing were redeemable below
// that, a user who walked the whole trail still couldn't buy anything on
// day one — the first redemption is what makes the currency feel real. It
// costs nothing to grant (buddy-service has zero marginal cost per match),
// works for both the gym and home track, and can't be farmed for value the
// way a gym trial could. NOTE: this only debits coins and records the
// redemption — nothing in buddy-service reads a redemption and actually
// grants 24h deck priority yet. That integration doesn't exist (verified
// 2026-09-11) and isn't part of this change.
//
// No gym_trial items are seeded here. Each one needs a real gymId and a
// real unitCostPaise (what the founder owes that specific gym per D-05) —
// those get created per gym via the admin catalog endpoints at partner
// signup, not invented as a placeholder with a fake gym attached.
const SEED_ITEMS = [
  {
    key: 'sub_discount_50',
    category: 'subscription_discount',
    title: 'Rs 50 off your next subscription',
    description: 'Redeemed automatically at checkout when you choose it while buying a gym subscription.',
    coinCost: 500,
    discountAmount: 50,
  },
  {
    key: 'buddy_boost_50',
    category: 'buddy_unlock',
    title: '24-hour buddy boost',
    description: 'Your profile shows first in the swipe deck for 24 hours.',
    coinCost: 50,
  },
];

async function ensureSeeded() {
  const count = await prisma.coinCatalogItem.count();
  if (count === 0) {
    await prisma.coinCatalogItem.createMany({ data: SEED_ITEMS });
  }
}

function startOfMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

// Annotates gym_trial items with the two things a customer actually needs
// to decide whether to redeem: how many of the shared monthly cap are left,
// and whether this user has already spent their lifetime one. Both are
// counted across the WHOLE category (see CoinEconomyConfig.gymTrialMonthlyCap
// comment) — a user who already claimed the neighbourhood trial cannot also
// claim the premium one, and the cap is shared across gyms/tiers, not per
// item.
//
// userId is optional so the unauthenticated web preview (PG-HUNT-001 H-11,
// not yet built) can still show honest scarcity without an account.
async function annotateGymTrials(items, userId) {
  const hasGymTrial = items.some((i) => i.category === 'gym_trial');
  if (!hasGymTrial) return items;

  const config = await loadEconomyConfig();
  const monthStart = startOfMonth();

  const [monthlyCount, userCount] = await Promise.all([
    prisma.coinRedemption.count({
      where: { status: 'fulfilled', createdAt: { gte: monthStart }, catalogItem: { category: 'gym_trial' } },
    }),
    userId
      ? prisma.coinRedemption.count({
          where: { userId, status: 'fulfilled', catalogItem: { category: 'gym_trial' } },
        })
      : Promise.resolve(0),
  ]);

  const unitsRemainingThisMonth = Math.max(0, config.gymTrialMonthlyCap - monthlyCount);
  const alreadyClaimedByUser = userId ? userCount >= config.gymTrialPerUserLimit : false;

  return items.map((item) =>
    item.category === 'gym_trial'
      ? { ...item, unitsRemainingThisMonth, alreadyClaimedByUser }
      : item
  );
}

export async function listActiveCatalogService(userId) {
  await ensureSeeded();
  const items = await prisma.coinCatalogItem.findMany({ where: { isActive: true }, orderBy: { coinCost: 'asc' } });
  return annotateGymTrials(items, userId);
}

export async function listCatalogAdminService() {
  await ensureSeeded();
  return prisma.coinCatalogItem.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function createCatalogItemAdminService({ key, category, title, description, coinCost, discountAmount, gymId, unitCostPaise, fundedBy, isActive }) {
  if (!key || !category || !title || !Number.isInteger(coinCost) || coinCost <= 0) {
    throw { status: 400, error: 'key, category, title and a positive integer coinCost are required' };
  }
  if (category === 'gym_trial' && (!Number.isInteger(gymId) || gymId <= 0)) {
    throw { status: 400, error: 'gymId is required for a gym_trial item' };
  }
  // Required, not just validated-if-present, for gym_trial specifically: an
  // item with no unitCostPaise would redeem successfully and silently
  // record `unitCostPaise: null` in every one of its redemptions' metadata,
  // which is exactly the field the monthly settlement (D-05) is reconciled
  // against — a gym_trial item that can be created without it is a payable
  // that can never be recovered. Every other category leaves it optional
  // (it means nothing to them).
  if (category === 'gym_trial') {
    if (!Number.isInteger(unitCostPaise) || unitCostPaise < 0) {
      throw { status: 400, error: 'unitCostPaise (in paise) is required for a gym_trial item' };
    }
  } else if (unitCostPaise !== undefined && unitCostPaise !== null && (!Number.isInteger(unitCostPaise) || unitCostPaise < 0)) {
    throw { status: 400, error: 'unitCostPaise must be a non-negative integer' };
  }
  return prisma.coinCatalogItem.create({
    data: {
      key,
      category,
      title,
      description: description ?? null,
      coinCost,
      discountAmount: discountAmount ?? null,
      gymId: category === 'gym_trial' ? gymId : null,
      unitCostPaise: category === 'gym_trial' ? (unitCostPaise ?? null) : null,
      fundedBy: category === 'gym_trial' ? (fundedBy ?? 'founder') : (fundedBy ?? null),
      isActive: isActive ?? true,
    },
  });
}

export async function updateCatalogItemAdminService(id, { title, description, coinCost, discountAmount, unitCostPaise, fundedBy, isActive }) {
  const existing = await prisma.coinCatalogItem.findUnique({ where: { id: Number(id) } });
  if (!existing) throw { status: 404, error: 'Catalog item not found' };
  // Same requirement as creation, checked here too: an update that clears
  // unitCostPaise on a gym_trial item would strand every future redemption
  // of it with no recorded payable — the price can change, but it can
  // never go back to unset.
  if (existing.category === 'gym_trial' && unitCostPaise === null) {
    throw { status: 400, error: 'unitCostPaise cannot be cleared on a gym_trial item' };
  }
  if (unitCostPaise !== undefined && unitCostPaise !== null && (!Number.isInteger(unitCostPaise) || unitCostPaise < 0)) {
    throw { status: 400, error: 'unitCostPaise must be a non-negative integer' };
  }
  return prisma.coinCatalogItem.update({
    where: { id: Number(id) },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(coinCost !== undefined ? { coinCost: Number(coinCost) } : {}),
      ...(discountAmount !== undefined ? { discountAmount: discountAmount === null ? null : Number(discountAmount) } : {}),
      ...(unitCostPaise !== undefined ? { unitCostPaise: unitCostPaise === null ? null : Number(unitCostPaise) } : {}),
      ...(fundedBy !== undefined ? { fundedBy } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
    },
  });
}

// Called internally by wallet-service at subscription-purchase time (never
// directly by a customer) — debits coins and records the redemption in one
// step, since there's no separate "reservation" phase in this build. If the
// wallet-side purchase fails afterward, the caller must call
// refundRedemptionService with the returned redemptionId.
//
// No inventory cap applies here: subscription_discount is the only category
// this path serves, and it has no cap. A category that DOES have a cap
// (gym_trial) goes through redeemCatalogItemByUserService instead, never
// this one — see that function for why the cap check can't be layered on
// top of debitCoinsService the way this one uses it.
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

const MAX_SERIALIZATION_RETRIES = 3;

// The customer-initiated redemption path (H-16, D-06) — what a user hits
// directly from the marketplace, as opposed to redeemCatalogItemService
// above, which only wallet-service calls as a step inside a subscription
// purchase it controls end to end.
//
// This path exists specifically because gym_trial has TWO constraints
// nothing else in the catalog has: a monthly cap shared across every item
// in the category, and a lifetime one-per-user limit also shared across the
// category. Both checks, the coin debit, and the redemption insert all
// happen inside ONE serializable transaction — they can't be separate calls
// (count, then debitCoinsService, then insert) the way redeemCatalogItemService
// can afford to be, because two concurrent redemptions against the last unit
// of a 10/month cap would otherwise both pass the count check before either
// one debits, and the tenth and eleventh trial of the month would both go
// out. Postgres aborts one side of that race under SERIALIZABLE isolation
// with a write-conflict error (Prisma surfaces it as P2034); this function
// catches that and retries, which is enough at the volume this ever runs at
// — gym_trial redemptions are a handful a month, not a checkout stampede.
//
// idempotencyKey is required (not optional like the internal path) because
// this is reachable from a client that can genuinely double-tap or retry on
// a flaky connection, and a Rs 300-600 gym pass is not something to risk
// issuing twice.
export async function redeemCatalogItemByUserService({ userId, catalogItemKey, idempotencyKey, metadata }) {
  if (!idempotencyKey) throw { status: 400, error: 'idempotencyKey is required' };

  const existing = await prisma.coinRedemption.findUnique({
    where: { idempotencyKey },
    include: { catalogItem: true },
  });
  if (existing) return serializeRedemption(existing, existing.catalogItem);

  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
    try {
      const redemption = await prisma.$transaction(
        async (tx) => {
          const item = await tx.coinCatalogItem.findUnique({ where: { key: catalogItemKey } });
          if (!item || !item.isActive) throw { status: 404, error: 'Catalog item not found or inactive' };

          if (item.category === 'gym_trial') {
            const config = await loadEconomyConfig();
            const monthStart = startOfMonth();

            const monthlyCount = await tx.coinRedemption.count({
              where: { status: 'fulfilled', createdAt: { gte: monthStart }, catalogItem: { category: 'gym_trial' } },
            });
            if (monthlyCount >= config.gymTrialMonthlyCap) {
              throw { status: 409, error: 'All gym trials for this month are claimed. Resets on the 1st.', code: 'GYM_TRIAL_CAP_REACHED' };
            }

            const userCount = await tx.coinRedemption.count({
              where: { userId, status: 'fulfilled', catalogItem: { category: 'gym_trial' } },
            });
            if (userCount >= config.gymTrialPerUserLimit) {
              throw { status: 409, error: 'You have already claimed a gym trial.', code: 'GYM_TRIAL_ALREADY_CLAIMED' };
            }
          }

          try {
            await debitCoinsInTx(tx, userId, item.coinCost, `Redeemed: ${item.title}`, idempotencyKey);
          } catch (err) {
            if (err.message === 'Insufficient coins') {
              throw { status: 400, error: 'Insufficient coins', code: 'INSUFFICIENT_COINS' };
            }
            throw err;
          }

          const redemptionMetadata =
            item.category === 'gym_trial'
              ? { ...(metadata ?? {}), gymId: item.gymId, unitCostPaise: item.unitCostPaise }
              : (metadata ?? null);

          return tx.coinRedemption.create({
            data: {
              userId,
              catalogItemId: item.id,
              coinCost: item.coinCost,
              status: 'fulfilled',
              metadata: redemptionMetadata,
              idempotencyKey,
            },
            include: { catalogItem: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return serializeRedemption(redemption, redemption.catalogItem);
    } catch (err) {
      // A concurrent redemption raced this one for the same cap slot.
      // Retry with a fresh count rather than surfacing a transient DB
      // conflict as a customer-facing error.
      if (err.code === 'P2034' && attempt < MAX_SERIALIZATION_RETRIES) continue;
      // A retry that lands on the idempotency key (e.g. the client retried
      // the same request while this function was mid-retry itself) surfaces
      // as a unique-constraint violation on insert — treat it the same as
      // finding it up front.
      if (err.code === 'P2002') {
        const raced = await prisma.coinRedemption.findUnique({
          where: { idempotencyKey },
          include: { catalogItem: true },
        });
        if (raced) return serializeRedemption(raced, raced.catalogItem);
      }
      throw err;
    }
  }
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
    metadata: redemption.metadata ?? null,
  };
}
