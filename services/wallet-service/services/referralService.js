import { PrismaClient } from '@prisma/client';
// Namespace import (not named) on purpose: webhook.test.js mocks
// walletService.js with a partial export set, and referralService is now
// reachable from walletController.js (the referral routes). A named import
// would fail module instantiation against that partial mock even though the
// webhook tests never touch referral code; a namespace import resolves to
// undefined only if actually accessed, which they don't.
import * as walletService from './walletService.js';

// Constructed lazily rather than at module top-level: walletController.js
// imports this module for its route handlers, and webhook.test.js (which
// loads walletController) does not mock @prisma/client — a top-level
// construction would run the real, ungenerated client there. Construction is
// deferred until a referral function actually touches the DB.
let prisma;
function getPrisma() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

// Referral money rules (docs coach-journey-tasks.html #c-money): ₹50 to each
// side, once per friend, whichever trigger fires first (the friend's first
// completed booking — booking-service — or their 3rd showed-up day behind the
// referralHomeTrigger flag — health-service). The trigger decision lives with
// the caller; this service only moves the two credits atomically and enforces
// the cap.
export const REFERRAL_BONUS = Number(process.env.REFERRAL_BONUS) || 50;
// At most 10 *paid* referrals (i.e. referrer-side credits) per referrer per
// calendar month (IST). The 11th and beyond still pay the friend, but the
// referrer stops earning until the month rolls over.
export const REFERRAL_MONTHLY_CAP = Number(process.env.REFERRAL_MONTHLY_CAP) || 10;

// Idempotency keys are unchanged from booking-service's original inline
// credits (bookingService.js:1153-1186) so the two code paths deduplicate
// against each other during the B3/B4 migration window.
export const REFERRAL_CREDIT_KEY_PREFIX = 'referral-credit-';
const REFERRER_KEY_PREFIX = 'referral-credit-referrer-';
const REFERRED_KEY_PREFIX = 'referral-credit-referred-';
const REFERRER_MARKER = '-for-';

// IST is a fixed UTC+5:30 with no DST — the same constant the subscription
// code uses (walletService.js daysSince/ISO_DAY neighbourhood).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function friendKeyFor(friendId) {
  return `${REFERRED_KEY_PREFIX}${friendId}`;
}

function referrerKeyFor(referrerId, friendId) {
  return `${REFERRER_KEY_PREFIX}${referrerId}${REFERRER_MARKER}${friendId}`;
}

// UTC instants bounding the IST calendar month containing `now`. `createdAt`
// on WalletTransaction is stored as a UTC timestamp, so the count query must
// compare against these bounds rather than trusting the DB/host timezone.
function istMonthBounds(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(year, month + 1, 1) - IST_OFFSET_MS);
  return { start, end };
}

function parseFriendIdFromReferrerKey(key) {
  const str = String(key || '');
  const idx = str.lastIndexOf(REFERRER_MARKER);
  if (idx === -1) return null;
  const id = Number(str.slice(idx + REFERRER_MARKER.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Credits the referrer ₹50 unless this referral is already paid (their key
// exists) or they've hit the monthly cap. Returns 'paid' | 'already' |
// 'capped'. Runs against the caller's tx so a referral credit and its
// cap-check are atomic — two concurrent first-referrals for the same referrer
// cannot both count themselves under the cap and both pay.
async function payReferrerIfEligible(tx, referrerId, friendId, now = new Date()) {
  const referrerKey = referrerKeyFor(referrerId, friendId);
  const existing = await tx.walletTransaction.findUnique({
    where: { idempotencyKey: referrerKey },
    select: { id: true },
  });
  if (existing) return 'already';

  const { start, end } = istMonthBounds(now);
  const paidThisMonth = await tx.walletTransaction.count({
    where: {
      idempotencyKey: { startsWith: `${REFERRER_KEY_PREFIX}${referrerId}${REFERRER_MARKER}` },
      createdAt: { gte: start, lt: end },
    },
  });
  if (paidThisMonth >= REFERRAL_MONTHLY_CAP) return 'capped';

  await walletService.applyWalletCredit(tx, {
    userId: referrerId,
    amount: REFERRAL_BONUS,
    description: 'Referral bonus',
    idempotencyKey: referrerKey,
    type: 'bonus',
  });
  return 'paid';
}

// POST /internal/referrals/credit — {referrerId, friendId, trigger}.
// The whole pair is written in one transaction: check the friend key (a
// retry/replay returns already_credited and changes nothing), pay the friend,
// then pay the referrer if under cap. `trigger` is part of the contract but
// does not affect the ledger decision here — booking-service and
// health-service decide which trigger fires; this service just settles it.
export async function creditReferralService({ referrerId, friendId } = {}) {
  const refId = Number(referrerId);
  const frId = Number(friendId);
  if (!Number.isInteger(refId) || refId <= 0) throw { status: 400, error: 'referrerId is required' };
  if (!Number.isInteger(frId) || frId <= 0) throw { status: 400, error: 'friendId is required' };
  if (refId === frId) throw { status: 400, error: 'referrerId and friendId must differ' };

  const friendKey = friendKeyFor(frId);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const existingFriend = await tx.walletTransaction.findUnique({
        where: { idempotencyKey: friendKey },
        select: { id: true },
      });
      if (existingFriend) return { status: 'already_credited' };

      await walletService.applyWalletCredit(tx, {
        userId: frId,
        amount: REFERRAL_BONUS,
        description: 'Referral bonus',
        idempotencyKey: friendKey,
        type: 'bonus',
      });

      const referrerStatus = await payReferrerIfEligible(tx, refId, frId);
      // 'already' means the referrer side landed earlier without the friend
      // side (shouldn't happen via this route, which checks the friend first);
      // the pair is fully paid either way, so report credited.
      return { status: referrerStatus === 'capped' ? 'capped' : 'credited' };
    });
  } catch (err) {
    // Concurrent identical call won the friend-key insert between our check
    // and our create — treat as an idempotent replay.
    if (err.code === 'P2002') return { status: 'already_credited' };
    throw err;
  }
}

// POST /internal/referrals/reconcile — repairs pairs left half-paid by a
// crash between the two credits (the original booking-service code wrote them
// as two independent HTTP calls, so a process death in between could leave
// one side credited and the other not). Pays the missing side, still
// respecting the referrer's monthly cap, and returns how many sides it fixed.
export async function reconcileReferralPayoutsService() {
  let fixed = 0;

  // Side 1: friend paid, referrer missing. Learn the referrer from the
  // friend's auth profile (the friend key doesn't carry it).
  const friendCredits = await getPrisma().walletTransaction.findMany({
    where: { type: 'bonus', idempotencyKey: { startsWith: REFERRED_KEY_PREFIX } },
    select: { idempotencyKey: true },
  });
  for (const row of friendCredits) {
    const friendId = Number(String(row.idempotencyKey).slice(REFERRED_KEY_PREFIX.length));
    if (!Number.isInteger(friendId) || friendId <= 0) continue;

    const referrerAlreadyPaid = await getPrisma().walletTransaction.findFirst({
      where: { idempotencyKey: { endsWith: `${REFERRER_MARKER}${friendId}` } },
      select: { id: true },
    });
    if (referrerAlreadyPaid) continue;

    const referrerId = await walletService.getReferredByUserIdInternal(friendId);
    if (!Number.isInteger(referrerId) || referrerId <= 0 || referrerId === friendId) continue;

    const status = await getPrisma().$transaction((tx) => payReferrerIfEligible(tx, referrerId, friendId));
    if (status === 'paid') fixed += 1;
  }

  // Side 2: referrer paid, friend missing (the reverse half-pair).
  const referrerCredits = await getPrisma().walletTransaction.findMany({
    where: { type: 'bonus', idempotencyKey: { startsWith: REFERRER_KEY_PREFIX } },
    select: { idempotencyKey: true },
  });
  for (const row of referrerCredits) {
    const friendId = parseFriendIdFromReferrerKey(row.idempotencyKey);
    if (friendId == null) continue;

    const friendKey = friendKeyFor(friendId);
    const friendAlreadyPaid = await getPrisma().walletTransaction.findUnique({
      where: { idempotencyKey: friendKey },
      select: { id: true },
    });
    if (friendAlreadyPaid) continue;

    try {
      await getPrisma().$transaction((tx) =>
        walletService.applyWalletCredit(tx, {
          userId: friendId,
          amount: REFERRAL_BONUS,
          description: 'Referral bonus',
          idempotencyKey: friendKey,
          type: 'bonus',
        })
      );
      fixed += 1;
    } catch (err) {
      // Concurrent reconcile already wrote it — not a failure, just nothing
      // left to fix for this pair.
      if (err.code !== 'P2002') throw err;
    }
  }

  return { fixed };
}
