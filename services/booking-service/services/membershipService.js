import prisma from '../db/prisma.js';
import axios from 'axios';
import { track } from '../utils/analytics.js';
import { configConflictError, parseExpectedUpdatedAt, writeConfigRow, writeSingleton } from '../utils/configConcurrency.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const REGION = 'GURUGRAM';
const DEFAULT_PAYOUT_PAISE = 7500;
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();
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

export async function resolveMembershipPayoutPaise(db, gymId) {
  const override = await db.gymMembershipPayout.findUnique({ where: { gymId } });
  return override?.payoutPaise ?? (await getMembershipPayoutConfig(db)).payoutPaise;
}

export function listGymMembershipPayouts() {
  return prisma.gymMembershipPayout.findMany({ orderBy: { gymId: 'asc' } });
}

function validatePayoutPaise(payoutPaise) {
  if (!isId(payoutPaise)) throw { status: 400, error: 'payoutPaise must be a positive integer' };
}

export async function updateMembershipPayoutConfig(payoutPaise, updatedBy, expectedUpdatedAt) {
  validatePayoutPaise(payoutPaise);
  const data = { payoutPaise, updatedBy };
  return writeSingleton(prisma.membershipPayoutConfig, {
    create: data, update: data, expected: parseExpectedUpdatedAt(expectedUpdatedAt),
  });
}

export async function updateGymMembershipPayout(gymId, payoutPaise, updatedBy, expectedUpdatedAt) {
  if (!isId(gymId)) throw { status: 400, error: 'Invalid gym id' };
  validatePayoutPaise(payoutPaise);
  const expected = parseExpectedUpdatedAt(expectedUpdatedAt);
  try {
    await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, {
      headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(GYM_SERVICE_URL)) },
      timeout: 3000,
    });
  } catch (err) {
    if (err.response?.status === 404) throw { status: 404, error: 'Gym not found' };
    throw { status: 503, error: 'Unable to verify gym' };
  }
  const data = { payoutPaise, updatedBy };
  return writeConfigRow(prisma.gymMembershipPayout, { gymId }, { create: data, update: data, expected });
}

export async function deleteGymMembershipPayout(gymId, expectedUpdatedAt) {
  if (!isId(gymId)) throw { status: 400, error: 'Invalid gym id' };
  const expected = parseExpectedUpdatedAt(expectedUpdatedAt);
  const delegate = prisma.gymMembershipPayout;
  const { count } = await delegate.deleteMany({
    where: { gymId, ...(expected && { updatedAt: expected }) },
  });
  if (!count && expected) {
    const current = await delegate.findUnique({ where: { gymId } });
    throw configConflictError(current?.updatedAt);
  }
  return { gymId, deleted: count === 1 };
}
