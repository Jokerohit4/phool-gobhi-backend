import prisma from '../db/prisma.js';
import { track } from '../utils/analytics.js';
import { parseExpectedUpdatedAt, writeSingleton } from '../utils/configConcurrency.js';

const REGION = 'GURUGRAM';
const DEFAULT_PAYOUT_PAISE = 7500;
const isId = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const isKey = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160;

export const isMembershipCity = city => ['gurugram', 'gurgaon'].includes(city?.trim().toLowerCase());

function parseDate(value) {
  return typeof value === 'string' ? new Date(value) : new Date(NaN);
}

// Serialize deliveries for a term, including a cancellation that arrives
// before the original grant. Booking reservations use Serializable isolation.
async function lockTerm(tx, orderRef) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(724, hashtext(${orderRef}::text))`;
}

export function trackMembershipEvent(send) {
  try {
    void Promise.resolve(send()).catch(() => {});
  } catch {}
}

export async function createGymEntitlement({ customerId, orderRef, offerKey, startsAt, endsAt, region, requiresClearance = false, source = 'purchase' }) {
  const start = parseDate(startsAt);
  const end = parseDate(endsAt);
  if (!isId(customerId) || !isKey(orderRef) || !isKey(offerKey) || !(start < end) ||
      region !== REGION || typeof requiresClearance !== 'boolean' || !['purchase', 'renewal'].includes(source)) {
    throw { status: 400, error: 'Invalid gym entitlement' };
  }
  const result = await prisma.$transaction(async tx => {
    await lockTerm(tx, orderRef);
    const existing = await tx.gymEntitlement.findUnique({ where: { orderRef } });
    if (existing) return { entitlement: existing, created: false };
    if (await tx.gymEntitlementCancellation.findUnique({ where: { orderRef } })) {
      return { entitlement: null, created: false };
    }
    const entitlement = await tx.gymEntitlement.create({
      data: { customerId, orderRef, offerKey, startsAt: start, endsAt: end, region, requiresClearance },
    });
    return { entitlement, created: true };
  });
  if (result.created) {
    trackMembershipEvent(() => track('membership_activated', customerId, {
      offer_key: offerKey, source, ends_at: end.toISOString(),
    }));
  }
  return result.entitlement;
}

export async function cancelGymEntitlement(orderRef) {
  if (!isKey(orderRef)) throw { status: 400, error: 'orderRef is required' };
  await prisma.$transaction(async tx => {
    await lockTerm(tx, orderRef);
    await tx.gymEntitlementCancellation.upsert({ where: { orderRef }, create: { orderRef }, update: {} });
    await tx.gymEntitlement.updateMany({ where: { orderRef, status: 'active' }, data: { status: 'cancelled' } });
    await tx.gymAddonBalance.updateMany({
      where: { termOrderRef: orderRef, cancelledAt: null },
      data: { remaining: 0, cancelledAt: new Date() },
    });
  });
  return { cancelled: true };
}

export async function grantGymAddon({ customerId, termOrderRef, idempotencyKey, sessions, expiresAt }) {
  const end = parseDate(expiresAt);
  if (!isId(customerId) || !isKey(termOrderRef) || !isKey(idempotencyKey) || !isId(sessions) || !Number.isFinite(+end)) {
    throw { status: 400, error: 'Invalid gym add-on grant' };
  }
  return prisma.$transaction(async tx => {
    await lockTerm(tx, termOrderRef);
    if (await tx.gymEntitlementCancellation.findUnique({ where: { orderRef: termOrderRef } })) {
      return { applied: false };
    }
    const { count } = await tx.gymAddonGrant.createMany({ data: { idempotencyKey }, skipDuplicates: true });
    if (!count) return { applied: false };

    const balance = await tx.gymAddonBalance.upsert({
      where: { termOrderRef },
      create: { customerId, termOrderRef, remaining: sessions, expiresAt: end },
      update: { remaining: { increment: sessions } },
    });
    if (balance.customerId !== customerId || +balance.expiresAt !== +end) {
      throw { status: 409, error: 'Add-on grant does not match this term' };
    }
    return { applied: true, remaining: balance.remaining };
  });
}

function activeEntitlementWhere(customerId, now, visit = now) {
  const earliest = +visit < +now ? visit : now;
  const latest = +visit > +now ? visit : now;
  return { customerId, status: 'active', region: REGION, startsAt: { lte: earliest }, endsAt: { gt: latest } };
}

function spendableBalanceWhere(customerId, asOf) {
  return { customerId, cancelledAt: null, expiresAt: { gt: asOf }, remaining: { gt: 0 } };
}

export function findVisitEntitlement(tx, customerId, now, visit = now) {
  return tx.gymEntitlement.findFirst({
    where: activeEntitlementWhere(customerId, now, visit),
    orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
  });
}

export async function consumeGymAddon(tx, customerId, visit) {
  const where = spendableBalanceWhere(customerId, visit);
  const balance = await tx.gymAddonBalance.findFirst({ where, orderBy: { expiresAt: 'asc' } });
  if (!balance) return null;
  const { count } = await tx.gymAddonBalance.updateMany({
    where: { ...where, id: balance.id },
    data: { remaining: { decrement: 1 } },
  });
  return count ? balance : null;
}

export async function getCustomerEntitlement(customerId) {
  const now = new Date();
  const [entitlement, balances] = await Promise.all([
    findVisitEntitlement(prisma, customerId, now),
    prisma.gymAddonBalance.findMany({ where: spendableBalanceWhere(customerId, now), orderBy: { expiresAt: 'desc' } }),
  ]);
  return {
    active: !!entitlement || balances.length > 0,
    unlimited: !!entitlement,
    expiresAt: entitlement?.endsAt ?? balances[0]?.expiresAt ?? null,
    addonRemaining: balances.reduce((sum, balance) => sum + balance.remaining, 0),
    clearanceRequired: !!entitlement?.requiresClearance,
  };
}

export async function getMembershipPayoutConfig(db = prisma) {
  return await db.membershipPayoutConfig.findUnique({ where: { id: 1 } }) ??
    { id: 1, payoutPaise: DEFAULT_PAYOUT_PAISE, updatedAt: null, updatedBy: null };
}

export async function updateMembershipPayoutConfig(payoutPaise, updatedBy, expectedUpdatedAt) {
  if (!isId(payoutPaise)) throw { status: 400, error: 'payoutPaise must be a positive integer' };
  const data = { payoutPaise, updatedBy };
  return writeSingleton(prisma.membershipPayoutConfig, {
    create: data, update: data, expected: parseExpectedUpdatedAt(expectedUpdatedAt),
  });
}
