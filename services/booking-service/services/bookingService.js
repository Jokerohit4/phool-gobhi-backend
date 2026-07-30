import { PrismaClient, Prisma } from '@prisma/client';
import axios from 'axios';
import { notifyPartner } from '../utils/notifyPartner.js';
import { notifyCustomer } from '../utils/notifyCustomer.js';
import { track } from '../utils/analytics.js';
import { isSlotInPastOrTooSoon, hoursUntilSlot, isSessionActiveNow, isBeforeSessionWindow, isSessionEnded, shiftedSlotForNow, todayDateStringIST } from '../utils/slotTiming.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { signQrToken, verifyQrToken } from '../utils/qrToken.js';

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const prisma = new PrismaClient();

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Booking's money fields are Decimal in Postgres (see schema.prisma) — every
// read site below runs the fetched/created/updated row through this
// immediately after the Prisma call, before any arithmetic or JSON response,
// so a raw Decimal object is never compared with </> (which does a STRING
// compare) or added to a number (which can silently string-concatenate).
// Same convention as wallet-service's Number(...) wrapping and gym-service's
// normalizeGymMoney.
function normalizeBookingMoney(booking) {
  if (!booking) return booking;
  const out = { ...booking };
  if (out.amount != null) out.amount = Number(out.amount);
  if (out.commissionPct != null) out.commissionPct = Number(out.commissionPct);
  if (out.partnerShare != null) out.partnerShare = Number(out.partnerShare);
  return out;
}

// Platform commission on regular (non-subscription) session bookings —
// mirrors wallet-service's SUBSCRIPTION_COMMISSION_PERCENT. Same rate by
// default, but a separate env var since the two are billed completely
// differently (per-session debit/credit here vs. upfront split there) and
// may need to move independently later.
const BOOKING_COMMISSION_PERCENT = Number(process.env.BOOKING_COMMISSION_PERCENT) || 20;

// Per-target headers for service-to-service calls (x-internal-key shared
// secret, plus a Google ID token on Cloud Run — see utils/googleIdToken.js —
// now required since each target's Cloud Run invoker no longer allows
// anonymous callers). Computed per call since the ID token is fetched
// async (internally cached/refreshed, so this is cheap).
async function internalHeadersFor(targetUrl) {
  return { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(targetUrl)) } };
}

// Best-effort customer name lookup for the early-scan confirmation dialog —
// same single-user internal call pattern as notifyCustomer.js. Never blocks
// the flow: a lookup failure just falls back to a generic label.
async function fetchCustomerName(customerId) {
  try {
    const res = await axios.get(`${AUTH_SERVICE_URL}/internal/${customerId}`, await internalHeadersFor(AUTH_SERVICE_URL));
    const user = res.data?.data || res.data;
    return user?.name || null;
  } catch (_) {
    return null;
  }
}

// Denormalizes gym city onto analytics events (booking/wallet events
// otherwise carry no geo dimension at all, making city-level conversion
// analysis require a join nothing currently does). Memoized rather than
// fetched fresh every time — this is for analytics properties, not anything
// transactional, so a ~1hr-stale city name is an acceptable tradeoff for
// not adding a gym-service round trip to every tracked event. Fails open to
// null: a lookup failure must never block the booking/wallet flow it's
// attached to.
const GYM_CITY_CACHE_TTL_MS = 60 * 60 * 1000;
const gymCityCache = new Map(); // gymId -> { city, expiresAt }

async function getGymCity(gymId) {
  const cached = gymCityCache.get(gymId);
  if (cached && cached.expiresAt > Date.now()) return cached.city;
  try {
    const res = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
    const city = (res.data?.data || res.data)?.city ?? null;
    gymCityCache.set(gymId, { city, expiresAt: Date.now() + GYM_CITY_CACHE_TTL_MS });
    return city;
  } catch (_) {
    return null;
  }
}

const RESERVE_MAX_ATTEMPTS = 4;
const RESERVE_RETRY_BASE_MS = 40;

// How long a booking can sit at `pending` before we treat it as stuck rather
// than "the request is still in flight" — must comfortably exceed the time
// createBooking normally takes between reserving the slot and confirming it
// (a couple of network calls), so a booking genuinely mid-request is never
// mistaken for an orphan.
const PENDING_STALE_MS = 2 * 60 * 1000;

function isStalePending(booking) {
  return booking.status === 'pending' && (Date.now() - new Date(booking.createdAt).getTime()) > PENDING_STALE_MS;
}

function debitIdempotencyKey(bookingId) {
  return `booking-debit-${bookingId}`;
}

// A booking can get stuck at `pending` if the process dies between
// reserveBookingSlot committing and the final confirm step in createBooking
// (e.g. a Cloud Run instance recycled mid-request) — there would otherwise
// be no way to tell whether the customer was actually charged, so no safe
// way to let them cancel or retry that slot.
//
// - Subscription-covered bookings never hit the wallet at all, so nothing
//   could have been charged in that window — just confirm it directly.
// - Paid bookings: ask wallet-service whether the debit tagged with this
//   booking's idempotency key actually landed. If yes, the customer WAS
//   charged, so confirm it (never delete a booking someone already paid
//   for). If no, nothing was charged, so release the slot by deleting the
//   stale row.
//
// Returns the resulting booking if it's now real (confirmed), or null if it
// was released. A non-stale `pending` booking (still genuinely in flight)
// is returned unchanged.
async function reconcileStalePendingBooking(booking) {
  if (!isStalePending(booking)) return booking;

  if (booking.subscriptionId) {
    return prisma.booking.update({ where: { id: booking.id }, data: { status: 'confirmed' } })
      .then(normalizeBookingMoney).catch(() => null);
  }

  try {
    const res = await axios.get(
      `${WALLET_SERVICE_URL}/internal/transactions/by-key/${debitIdempotencyKey(booking.id)}`,
      await internalHeadersFor(WALLET_SERVICE_URL)
    );
    const wasCharged = !!res.data?.data;
    if (wasCharged) {
      return prisma.booking.update({ where: { id: booking.id }, data: { status: 'confirmed' } })
        .then(normalizeBookingMoney).catch(() => null);
    }
    const { count } = await prisma.booking.deleteMany({ where: { id: booking.id, status: 'pending' } });
    return count ? null : booking;
  } catch (_) {
    // wallet-service unreachable — leave it pending, reconcile again next time
    return booking;
  }
}

// Atomically checks for a duplicate active booking and slot capacity, then
// inserts the booking as `pending` — all inside one Serializable transaction
// so two concurrent requests for the last open slot can't both pass the
// capacity check before either inserts (Postgres's serializable snapshot
// isolation aborts the loser, which Prisma surfaces as error code P2034).
// The row is created `pending`, not `confirmed`, specifically so this
// transaction never has to stay open across the wallet-debit network call
// that follows in createBooking — it commits (or releases) purely locally.
// Subscription-covered bookings never pay out a per-session partner share
// here (the partner was already paid upfront at subscription purchase — see
// fulfillSubscriptionPurchase), so they get no commission snapshot at all.
function bookingCommissionFields(amount, subscriptionId) {
  if (subscriptionId) return { commissionPct: null, partnerShare: null };
  const commissionPct = BOOKING_COMMISSION_PERCENT;
  const partnerShare = Math.round(amount * (1 - commissionPct / 100) * 100) / 100;
  return { commissionPct, partnerShare };
}

async function reserveBookingSlot({ customerId, gymId, date, startTime, endTime, amount, capacity, subscriptionId = null }) {
  for (let attempt = 1; attempt <= RESERVE_MAX_ATTEMPTS; attempt++) {
    // Reconcile a stale pending duplicate BEFORE opening the transaction —
    // reconciliation can make an HTTP call to wallet-service, which must
    // never run inside an open DB transaction (see below). A duplicate
    // that's still fresh (or a real confirmed booking) comes back unchanged
    // and correctly rejects this attempt, same as before.
    const existingDuplicate = await prisma.booking.findFirst({
      where: { customerId, gymId, date, startTime, status: { not: 'cancelled' } },
    });
    if (existingDuplicate) {
      const reconciled = await reconcileStalePendingBooking(existingDuplicate);
      if (reconciled) {
        throw { status: 409, error: 'You already have a booking for this slot' };
      }
      // else: reconciliation released the stale row — fall through and reserve fresh
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.booking.findFirst({
          where: { customerId, gymId, date, startTime, status: { not: 'cancelled' } },
          select: { id: true },
        });
        if (duplicate) {
          throw { status: 409, error: 'You already have a booking for this slot' };
        }

        const activeCount = await tx.booking.count({
          where: { gymId, date, startTime, status: { not: 'cancelled' } },
        });
        if (activeCount >= capacity) {
          throw { status: 409, error: 'Slot is full' };
        }

        return tx.booking.create({
          data: {
            customerId, gymId, date, startTime, endTime, amount, status: 'pending', subscriptionId,
            ...bookingCommissionFields(amount, subscriptionId),
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return normalizeBookingMoney(created);
    } catch (err) {
      // Business-rule rejection (duplicate slot / full slot) — surface immediately, don't retry.
      if (err && err.status) throw err;

      // P2034 = Prisma's mapping of a Postgres serialization failure (SQLSTATE
      // 40001) inside an interactive transaction: a concurrent booking for
      // this exact slot committed between our count check and insert. Retry
      // from scratch rather than surfacing a transient error to the customer.
      if (err?.code === 'P2034' && attempt < RESERVE_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RESERVE_RETRY_BASE_MS * attempt));
        continue;
      }

      // Unique-violation on the partial index (see migration
      // 20260717130000_booking_indexes_and_unique_slot) — belt-and-suspenders
      // backstop in case two transactions both slipped past the findFirst
      // duplicate check; shouldn't happen under Serializable, cheap to guard.
      if (err?.code === 'P2002') {
        throw { status: 409, error: 'You already have a booking for this slot' };
      }

      throw err;
    }
  }
}

// Fires notifications when a booking is confirmed by the partner.
// Separate from the payment-success path so partners have a chance to review.
async function notifyOnConfirmation(booking, { customerId, gymId, date, startTime, subscriptionId, city }) {
  track('booking_confirmed', customerId, {
    booking_id: booking.id, gym_id: gymId, amount: booking.amount, date, start_time: startTime,
    via: subscriptionId ? 'subscription' : 'wallet', city,
  });

  notifyPartner(gymId, booking).catch(() => {});
  notifyCustomer(customerId, {
    title: 'Booking confirmed',
    body: `Your session on ${booking.date} at ${booking.startTime} is confirmed. ₹${booking.amount} debited.`,
    data: { type: 'booking_confirmed', bookingId: booking.id, date: booking.date },
  }).catch(() => {});
}

export async function createBooking(customerId, { gymId, date, startTime, endTime }) {
  try {
    // 1. Fetch gym details from gym-service — pass startTime so the response
    // resolves the correct per-slot price (falls back to sessionPrice
    // server-side if this slot has no explicit price set).
    let gym;
    try {
      const response = await axios.get(
        `${GYM_SERVICE_URL}/internal/${gymId}?startTime=${encodeURIComponent(startTime)}`,
        await internalHeadersFor(GYM_SERVICE_URL)
      );
      gym = response.data.data || response.data;
    } catch (err) {
      throw {
        status: 404,
        error: 'Gym not found'
      };
    }

    // Blocks the cheap version of self-booking fraud — a partner using their
    // own login to book (and complete, and review) their own gym to inflate
    // attendance/rating numbers. Doesn't catch a partner using a second
    // account with a different phone number; that needs real multi-account
    // detection, not an id comparison.
    if (gym.partnerId === customerId) {
      throw { status: 403, error: 'You cannot book a session at your own gym' };
    }

    const capacity = gym.capacity;
    const amount = gym.resolvedSlotPrice ?? gym.sessionPrice;

    if (isSlotInPastOrTooSoon(date, startTime)) {
      throw {
        status: 400,
        error: 'This slot has already passed or starts too soon to book'
      };
    }

    // 1a. Require a complete profile (name + date of birth) before booking —
    // both are optional at OTP signup, so a customer can otherwise reach
    // this endpoint before ever filling them in. Mirrors the app's own
    // pre-booking check, enforced here too since that check is client-side only.
    try {
      const profileRes = await axios.get(`${AUTH_SERVICE_URL}/internal/${customerId}`, await internalHeadersFor(AUTH_SERVICE_URL));
      const profile = profileRes.data;
      if (!profile?.name?.trim() || !profile?.dateOfBirth) {
        throw {
          status: 400,
          error: 'Please add your name and date of birth before booking'
        };
      }
    } catch (err) {
      if (err.status) throw err;
      // auth-service unreachable — fail closed, same as a missing profile,
      // rather than silently letting an unverifiable booking through.
      throw {
        status: 400,
        error: 'Could not verify your profile — please try again'
      };
    }

    // 1b. Check if slot is blocked
    try {
      const blockRes = await axios.get(
        `${GYM_SERVICE_URL}/${gymId}/blocks?date=${date}`,
        await internalHeadersFor(GYM_SERVICE_URL)
      );
      const blocks = blockRes.data?.data || [];
      const isBlocked = blocks.some(b => b.startTime === startTime);
      if (isBlocked) {
        throw { status: 409, error: 'This slot has been blocked by the gym' };
      }
    } catch (err) {
      if (err.error) throw err;
      // If block check fails, allow booking (non-critical)
    }

    // 1c. Subscription entitlement check — does this customer have an active
    // subscription for this gym, and have they already used their one free
    // session at this gym today? Any failure here (wallet-service
    // unreachable, etc.) falls through to the normal paid flow below — an
    // outage must never silently grant free access.
    let subscriptionId = null;
    try {
      const subRes = await axios.get(
        `${WALLET_SERVICE_URL}/internal/subscriptions/active?customerId=${customerId}&gymId=${gymId}`,
        await internalHeadersFor(WALLET_SERVICE_URL)
      );
      if (subRes.data?.data?.active) {
        const usedToday = await prisma.booking.findFirst({
          where: { customerId, gymId, date, subscriptionId: { not: null }, status: { not: 'cancelled' } },
          select: { id: true },
        });
        // Already used today's free session — this booking falls back to the
        // normal paid flow rather than being blocked outright.
        if (!usedToday) {
          subscriptionId = subRes.data.data.subscription.id;
        }
      }
    } catch (_) {
      // wallet-service unreachable — fall through to the paid flow
    }

    // 2-3. Reserve the slot: duplicate-booking and capacity checks plus the
    // insert happen atomically (see reserveBookingSlot) so two concurrent
    // requests for the last open slot can't both pass the capacity check.
    // The row lands as `pending` — a real reservation, not yet paid for.
    let reservation;
    try {
      reservation = await reserveBookingSlot({ customerId, gymId, date, startTime, endTime, amount, capacity, subscriptionId });
    } catch (err) {
      if (err?.status === 409 && err.error === 'Slot is full') {
        track('booking_failed', customerId, { gym_id: gymId, reason: 'slot_full', date, start_time: startTime, city: gym.city });
      }
      throw err;
    }

    // 4. Debit customer wallet — skipped entirely when this booking is
    // covered by an active subscription (subscriptionId set above). The
    // reservation above already committed locally, so this network call
    // never runs inside an open DB transaction.
    if (!subscriptionId) {
      try {
        await axios.post(`${WALLET_SERVICE_URL}/${customerId}/debit`, {
          amount,
          description: 'Gym session booking',
          // Tags this debit to this specific reservation so a retry/
          // reconciliation of the same booking can never double-charge it
          // (see reconcileStalePendingBooking).
          idempotencyKey: debitIdempotencyKey(reservation.id),
        }, await internalHeadersFor(WALLET_SERVICE_URL));
      } catch (err) {
        // The debit call itself failed — but a network blip/timeout can
        // throw here even when the debit actually landed server-side (the
        // request succeeded but the response was lost). Check via the
        // idempotency key before assuming it didn't: deleting a reservation
        // the customer was actually charged for would be worse than the bug
        // this whole mechanism exists to prevent.
        let actuallyCharged = false;
        try {
          const check = await axios.get(
            `${WALLET_SERVICE_URL}/internal/transactions/by-key/${debitIdempotencyKey(reservation.id)}`,
            await internalHeadersFor(WALLET_SERVICE_URL)
          );
          actuallyCharged = !!check.data?.data;
        } catch (_) {
          // Can't tell right now — fall through and release below. If it
          // did land, the slot stays reserved (`pending`) and
          // reconcileStalePendingBooking will handle it if needed.
        }

        if (!actuallyCharged) {
          // Genuinely not charged — release the reservation so the slot goes
          // back to looking untouched.
          await prisma.booking.delete({ where: { id: reservation.id } }).catch(() => {});
          track('booking_failed', customerId, { gym_id: gymId, reason: 'insufficient_balance', amount, city: gym.city });
          throw {
            status: 400,
            error: err.response?.data?.error || 'Insufficient wallet balance'
          };
        }
        // else: actuallyCharged, so booking stays pending (charged but not yet confirmed by partner)
      }
    }

    // 5. Payment succeeded (or wasn't needed) — booking stays pending,
    // awaiting partner confirmation. Notify customer that payment was taken.
    track('booking_created', customerId, {
      booking_id: reservation.id, gym_id: gymId, amount: reservation.amount, date, start_time: startTime,
      via: subscriptionId ? 'subscription' : 'wallet', city: gym.city,
    });

    notifyCustomer(customerId, {
      title: 'Booking request sent',
      body: `Your session on ${reservation.date} at ${reservation.startTime} is pending gym confirmation. ₹${reservation.amount} debited.`,
      data: { type: 'booking_created', bookingId: reservation.id, date: reservation.date },
    }).catch(() => {});

    const confirmed = normalizeBookingMoney(reservation);
    return { ...confirmed, qrToken: signQrToken(confirmed.id, confirmed.gymId) };
  } catch (err) {
    if (err.error) throw err;
    console.error('createBooking error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

// Tiered cancellation refund policy — how much of the session amount comes
// back depends on how much notice the customer gave before the slot starts.
// Mirrored (for display only, never trusted) on the app's policy screen so it
// can show the applicable tier before the customer confirms — this function
// is the only place that actually decides the refund. Admin-portal-editable
// via CancellationPolicySetting; DEFAULT_TIERS is only the seed/fallback.
const DEFAULT_CANCELLATION_TIERS = [
  { maxHoursNotice: 1, blocked: true, refundRate: 0 },
  { maxHoursNotice: 4, blocked: false, refundRate: 0.3 },
  { maxHoursNotice: 8, blocked: false, refundRate: 0.5 },
  { maxHoursNotice: null, blocked: false, refundRate: 1.0 },
];

export async function getCancellationPolicy() {
  const row = await prisma.cancellationPolicySetting.findUnique({ where: { id: 1 } });
  return { tiers: row ? row.tiers : DEFAULT_CANCELLATION_TIERS, updatedAt: row?.updatedAt ?? null };
}

export async function updateCancellationPolicy(tiers, updatedBy) {
  if (!Array.isArray(tiers) || !tiers.length) {
    throw { status: 400, error: 'tiers must be a non-empty array' };
  }
  for (const t of tiers) {
    if (typeof t.refundRate !== 'number' || t.refundRate < 0 || t.refundRate > 1) {
      throw { status: 400, error: 'each tier needs a refundRate between 0 and 1' };
    }
  }
  const saved = await prisma.cancellationPolicySetting.upsert({
    where: { id: 1 },
    create: { id: 1, tiers, updatedBy },
    update: { tiers, updatedBy },
  });
  return { tiers: saved.tiers, updatedAt: saved.updatedAt };
}

async function cancellationRefundRate(hoursUntil) {
  const { tiers } = await getCancellationPolicy();
  for (const tier of tiers) {
    if (tier.maxHoursNotice === null || hoursUntil < tier.maxHoursNotice) {
      return tier.blocked ? null : tier.refundRate;
    }
  }
  return null;
}

export async function cancelBooking(bookingId, customerId) {
  try {
    // 1. Find booking
    let booking = normalizeBookingMoney(await prisma.booking.findUnique({
      where: { id: bookingId }
    }));

    if (!booking) {
      throw {
        status: 404,
        error: 'Booking not found'
      };
    }

    // 2. Verify booking belongs to customer
    if (booking.customerId !== customerId) {
      throw {
        status: 403,
        error: 'Forbidden'
      };
    }

    // 2a. A booking stuck at `pending` (see reconcileStalePendingBooking) can
    // be safely cancelled as long as we know whether the customer was charged.
    // For stale pending bookings, check; for fresh ones, we assume they'll
    // resolve normally (partner will confirm or customer's wallet will reject).
    if (booking.status === 'pending' && isStalePending(booking)) {
      const reconciled = await reconcileStalePendingBooking(booking);
      if (!reconciled) {
        // Released: never charged (or already resolved) — nothing to cancel.
        throw { status: 404, error: 'Booking no longer exists' };
      }
      booking = reconciled;
      if (booking.status === 'pending') {
        // Still genuinely in flight (not stale yet) — not stuck, just early.
        throw { status: 400, error: 'This booking is still being processed — try again in a moment' };
      }
    }

    // 2b. Tiered cancellation window for confirmed bookings: blocked inside
    // 1 hour of the slot; otherwise the refund rate depends on how much notice
    // was given. For pending bookings (not yet confirmed by gym), allow
    // cancellation anytime with full refund since gym hasn't committed resources.
    let refundRate = 1.0;
    if (booking.status === 'confirmed') {
      const hoursUntil = hoursUntilSlot(booking.date, booking.startTime);
      refundRate = await cancellationRefundRate(hoursUntil);
      if (refundRate === null) {
        throw { status: 400, error: 'Bookings cannot be cancelled within 1 hour of the session' };
      }
    }

    // 3-4. Atomically flip (pending|confirmed) -> cancelled first, gating the
    // refund on this single conditional update succeeding. Previously the wallet
    // credit ran BEFORE this status flip: if the process crashed in between,
    // the booking was left `confirmed` but already refunded, and since
    // `status === 'confirmed'` was the only guard elsewhere, it could later
    // be completed (crediting the partner too) or cancelled again (a second
    // customer credit). `updateMany` + `count === 1` makes a concurrent
    // second cancel attempt no-op instead of double-crediting.
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, customerId, status: { in: ['pending', 'confirmed'] } },
      data: { status: 'cancelled' },
    });
    if (count !== 1) {
      throw {
        status: 400,
        error: 'Booking cannot be cancelled'
      };
    }

    // 5. Refund — only reached once the status flip has already committed.
    // Skipped when this booking was covered by an active subscription: the
    // customer never spent wallet balance on it (they paid for the
    // subscription itself, separately, upfront), so crediting them here
    // would be free money for a session they didn't pay for individually.
    // If this fails, the booking stays correctly cancelled but unrefunded —
    // a known reconciliation gap (same class as the best-effort partner
    // payout in completeBooking below), logged clearly for manual follow-up
    // rather than building a full saga/outbox for it.
    const refundAmount = Math.round(booking.amount * refundRate * 100) / 100;
    if (!booking.subscriptionId) {
      try {
        await axios.post(`${WALLET_SERVICE_URL}/${customerId}/credit`, {
          amount: refundAmount,
          description: `Booking cancellation refund (${Math.round(refundRate * 100)}%)`
        }, await internalHeadersFor(WALLET_SERVICE_URL));
      } catch (err) {
        console.error('Refund failed for cancelled booking', bookingId, err.message);
        throw {
          status: 502,
          error: 'Booking was cancelled but the refund failed — contact support'
        };
      }
    }

    const updatedBooking = { ...booking, status: 'cancelled', refundAmount, refundRate };

    track('booking_cancelled', customerId, {
      booking_id: booking.id, gym_id: booking.gymId, amount: booking.amount, date: booking.date,
      refund_rate: refundRate, refund_amount: refundAmount, hours_until_slot: hoursUntil,
      city: await getGymCity(booking.gymId),
    });

    notifyCustomer(customerId, {
      title: 'Booking cancelled',
      body: booking.subscriptionId
        ? `Your session on ${booking.date} was cancelled.`
        : `Your session on ${booking.date} was cancelled. ₹${refundAmount} (${Math.round(refundRate * 100)}%) refunded to your wallet.`,
      data: { type: 'booking_cancelled', bookingId: booking.id, date: booking.date },
    }).catch(() => {});

    // 6. Return updated booking
    return updatedBooking;
  } catch (err) {
    if (err.error) throw err;
    console.error('cancelBooking error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function completeBooking(bookingId, gymId, partnerId, { override = false, overrideReason } = {}) {
  try {
    // 1. Find booking
    const booking = normalizeBookingMoney(await prisma.booking.findUnique({
      where: { id: bookingId }
    }));

    if (!booking) {
      throw {
        status: 404,
        error: 'Booking not found'
      };
    }

    // 2. Verify booking belongs to gym
    if (booking.gymId !== gymId) {
      throw {
        status: 403,
        error: 'Forbidden'
      };
    }

    // 3. Verify status allows completion — 'started' is the normal case
    // (attendance already verified by verifyAttendance/selfCheckIn); a
    // still-'confirmed' booking is only completable via an explicit
    // override (see step 5a) since no scan/self-check-in ever happened.
    if (booking.status !== 'confirmed' && booking.status !== 'started') {
      throw {
        status: 400,
        error: 'Booking cannot be completed'
      };
    }

    // 4. A session can only be completed on its own date — stops a scanned/forged
    //    booking ID from being marked complete on the wrong day.
    const todayString = todayDateStringIST();
    if (booking.date !== todayString) {
      throw {
        status: 400,
        error: 'This session is not scheduled for today'
      };
    }

    // 5. Verify partner owns this gym (fetch gym once — reused for payout)
    let gym;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      gym = gymRes.data?.data || gymRes.data;
    } catch (_) {
      throw { status: 404, error: 'Gym not found' };
    }
    if (!gym || gym.partnerId !== partnerId) {
      throw { status: 403, error: 'Forbidden' };
    }

    // 5a. Require verified attendance before payout — a scan via
    // verifyAttendance is the real "this session happened" signal; without
    // it (or an explicit partner override, e.g. the customer's phone died)
    // this would just be the old unenforced complete-without-checking-in
    // behavior this feature exists to close.
    if (!booking.attendedAt && !override) {
      throw {
        status: 400,
        error: "Attendance must be verified — scan the customer's QR code before completing this booking",
      };
    }

    const attendanceData = booking.attendedAt
      ? {}
      : {
          attendedAt: new Date(),
          attendanceMethod: 'manual_override',
          attendanceVerifiedBy: partnerId,
          attendanceOverrideReason: overrideReason || null,
        };

    // 6. Update status to 'completed' — conditioned on the status still being
    // 'confirmed' so two concurrent completion requests (double-tap, two
    // devices) can't both pass the check above and both trigger a payout;
    // only one update actually matches and the loser sees count === 0.
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, status: { in: ['confirmed', 'started'] } },
      data: { status: 'completed', ...attendanceData }
    });
    if (count === 0) {
      throw { status: 400, error: 'Booking cannot be completed' };
    }
    const updatedBooking = normalizeBookingMoney(await prisma.booking.findUnique({ where: { id: bookingId } }));

    // 7. Credit partner wallet — best-effort, never blocks completion.
    // Skipped when this booking was covered by an active subscription: the
    // partner's share was already credited upfront at subscription purchase
    // (see wallet-service's fulfillSubscriptionPurchase) — crediting again
    // here would pay them twice for the same session.
    // partnerShare is null for bookings created before this field existed —
    // fall back to the full amount for those rather than paying out `null`.
    const payoutAmount = booking.partnerShare ?? booking.amount;
    if (!booking.subscriptionId) {
      try {
        if (gym.partnerId) {
          await axios.post(`${WALLET_SERVICE_URL}/${gym.partnerId}/credit`, {
            amount: payoutAmount,
            description: 'Gym session payout',
            userType: 'partner',
            gymId,
          }, await internalHeadersFor(WALLET_SERVICE_URL));
        }
      } catch (payoutErr) {
        console.error('Partner payout failed for booking', bookingId, payoutErr.message);
      }
    }

    // Fulfillment funnel: the session actually happened (partner verified at the gym).
    track('booking_completed', booking.customerId, {
      booking_id: booking.id, gym_id: gymId, amount: booking.amount, date: booking.date,
      commission_pct: booking.commissionPct, partner_share: booking.partnerShare,
      attendance_method: updatedBooking.attendanceMethod, city: gym.city,
    });

    notifyCustomer(booking.customerId, {
      title: 'Session completed',
      body: `Your session on ${booking.date} is marked complete. See you next time!`,
      data: { type: 'booking_completed', bookingId: booking.id, date: booking.date },
    }).catch(() => {});

    return { ...updatedBooking, locationVerified: booking.locationVerified ?? false };
  } catch (err) {
    if (err.error) throw err;
    console.error('completeBooking error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

// Partner scans the customer's QR (a signed token, not a bare booking id —
// see qrToken.js) at the gym, or manually confirms attendance from
// partner-web (no camera there). This is the enforced "the session actually
// happened" signal completeBooking now requires. Idempotent: re-scanning an
// already-verified booking just returns its existing verification instead of
// erroring, since a camera can fire multiple detections for one physical scan.
export async function verifyAttendance(bookingId, gymId, partnerId, { method = 'qr_scan', qrToken, confirmSlotShift = false } = {}) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw { status: 404, error: 'Booking not found' };
    if (booking.gymId !== gymId) throw { status: 403, error: 'Forbidden' };

    let gym;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      gym = gymRes.data?.data || gymRes.data;
    } catch (_) {
      throw { status: 404, error: 'Gym not found' };
    }
    if (!gym || gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

    if (booking.status === 'cancelled') throw { status: 400, error: 'Booking is cancelled' };
    if (booking.status === 'completed' && !booking.attendedAt) {
      // Shouldn't happen post-launch (completeBooking always sets attendedAt
      // now), but a booking completed before this feature shipped has no
      // attendance record to verify against.
      throw { status: 400, error: 'Booking is already completed' };
    }

    const todayString = todayDateStringIST();
    if (booking.date !== todayString) throw { status: 400, error: 'This session is not scheduled for today' };

    // Idempotency check runs before any window check — a camera can fire
    // multiple detections for one physical scan, and re-scanning an
    // already-verified booking must never fail just because the window has
    // since closed.
    if (booking.attendedAt) {
      return {
        bookingId: booking.id,
        attendedAt: booking.attendedAt,
        attendanceMethod: booking.attendanceMethod,
        alreadyVerified: true,
      };
    }

    if (booking.status !== 'confirmed') throw { status: 400, error: 'Booking cannot be checked in' };

    // A scan after the session's end time is simply too late — no
    // confirm-and-continue option, unlike the early case below.
    if (isSessionEnded(booking.date, booking.endTime)) {
      throw { status: 400, error: 'This session has already ended', code: 'SESSION_ENDED' };
    }

    let slotShift = null;
    if (isBeforeSessionWindow(booking.date, booking.startTime)) {
      const proposed = shiftedSlotForNow(booking.date, booking.startTime, booking.endTime);
      if (!confirmSlotShift) {
        const customerName = await fetchCustomerName(booking.customerId);
        throw {
          status: 409,
          error: 'This is a different slot time than expected.',
          code: 'SLOT_TIME_MISMATCH',
          confirmation: {
            customerName: customerName || 'This customer',
            currentStartTime: booking.startTime,
            currentEndTime: booking.endTime,
            newStartTime: proposed.newStartTime,
            newEndTime: proposed.newEndTime,
          },
        };
      }
      slotShift = proposed;
    }

    // A real camera scan must present a valid signed token — a bare gymId is
    // no longer enough to prove a scan actually happened. partner-web has no
    // camera, so it explicitly asks for 'manual' instead of faking a scan.
    let attendanceMethod;
    if (method === 'manual') {
      attendanceMethod = 'manual_verify';
    } else {
      const check = verifyQrToken(qrToken, bookingId, gymId);
      if (!check.valid) {
        throw { status: 400, error: 'This QR code could not be verified — please rescan or use manual verification.', code: 'INVALID_QR' };
      }
      attendanceMethod = 'qr_scan';
    }

    const bookingUpdate = prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'started',
        attendedAt: new Date(),
        attendanceMethod,
        attendanceVerifiedBy: partnerId,
        ...(slotShift
          ? { startTime: slotShift.newStartTime, endTime: slotShift.newEndTime, slotShiftWarning: true }
          : {}),
      },
    });

    const [updated] = slotShift
      ? await prisma.$transaction([
          bookingUpdate,
          prisma.attendanceWarning.create({
            data: {
              bookingId: booking.id,
              customerId: booking.customerId,
              gymId,
              date: booking.date,
              originalStartTime: booking.startTime,
              originalEndTime: booking.endTime,
              newStartTime: slotShift.newStartTime,
              newEndTime: slotShift.newEndTime,
            },
          }),
        ])
      : [await bookingUpdate];

    track(slotShift ? 'attendance_slot_mismatch_confirmed' : 'attendance_verified', booking.customerId, {
      booking_id: booking.id, gym_id: gymId, method: attendanceMethod, city: gym.city,
    });

    return {
      bookingId: updated.id,
      attendedAt: updated.attendedAt,
      attendanceMethod: updated.attendanceMethod,
      alreadyVerified: false,
      ...(slotShift ? { slotShifted: true, newStartTime: slotShift.newStartTime, newEndTime: slotShift.newEndTime } : {}),
    };
  } catch (err) {
    if (err.error) throw err;
    console.error('verifyAttendance error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}

// Customer self-check-in via a static per-gym poster QR (a deeplink that
// just encodes gymId, not a specific booking — unlike verifyAttendance's
// per-booking QR). Finds whichever of the customer's own confirmed bookings
// at this gym is actually in-session right now, then gates on geofence
// instead of a partner's scan. Two distinct, client-branchable error codes
// (NO_ACTIVE_BOOKING / TOO_FAR) because the customer app shows meaningfully
// different UI for each (suggest booking a slot vs. "move closer and
// retry") — every other controller in this file uses a bare {error}
// string, but string-matching that in the client would be fragile, so this
// one deliberately carries a `code` alongside it.
export async function selfCheckIn(gymId, customerId, lat, lng) {
  try {
    const todayString = todayDateStringIST();
    const candidates = await prisma.booking.findMany({
      where: { customerId, gymId, date: todayString, status: 'confirmed' },
    });
    const booking = candidates.find((b) => isSessionActiveNow(b.date, b.startTime, b.endTime));

    if (!booking) {
      throw {
        status: 404,
        error: "You don't have a session at this gym right now",
        code: 'NO_ACTIVE_BOOKING',
      };
    }

    if (booking.attendedAt) {
      return {
        bookingId: booking.id,
        attendedAt: booking.attendedAt,
        attendanceMethod: booking.attendanceMethod,
        alreadyVerified: true,
      };
    }

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw { status: 400, error: 'Location is required to check in', code: 'LOCATION_REQUIRED' };
    }

    let gym;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      gym = gymRes.data?.data || gymRes.data;
    } catch (_) {
      throw { status: 404, error: 'Gym not found' };
    }

    const withinRange = gym?.lat && gym?.lng ? distanceMeters(lat, lng, gym.lat, gym.lng) <= 50 : false;
    if (!withinRange) {
      throw {
        status: 400,
        error: "You don't seem to be at the gym yet — move closer and try again",
        code: 'TOO_FAR',
      };
    }

    // attendanceVerifiedBy deliberately left null — that field means "which
    // partner recorded this"; self-check-in has no verifying partner, and
    // attendanceMethod='qr_geofence_self' already says who/how.
    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'started', attendedAt: new Date(), attendanceMethod: 'qr_geofence_self' },
    });

    track('attendance_verified', customerId, {
      booking_id: booking.id, gym_id: gymId, method: 'qr_geofence_self', city: gym?.city ?? null,
    });

    return {
      bookingId: updated.id,
      attendedAt: updated.attendedAt,
      attendanceMethod: updated.attendanceMethod,
      alreadyVerified: false,
    };
  } catch (err) {
    if (err.error) throw err;
    console.error('selfCheckIn error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}

export async function requestCheckIn(bookingId, customerId, lat, lng) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw { status: 404, error: 'Booking not found' };
    if (booking.customerId !== customerId) throw { status: 403, error: 'Forbidden' };
    if (booking.status !== 'confirmed') throw { status: 400, error: 'Booking is not confirmed' };
    const todayString = todayDateStringIST();
    if (booking.date !== todayString) throw { status: 400, error: 'This session is not scheduled for today' };

    let locationVerified = false;
    let gymCity = null;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${booking.gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      const gym = gymRes.data.data || gymRes.data;
      gymCity = gym.city ?? null;
      if (lat && lng && gym.lat && gym.lng) {
        locationVerified = distanceMeters(lat, lng, gym.lat, gym.lng) <= 300;
      }
    } catch (_) {
      // soft check — gym service failure does not block check-in
    }

    await prisma.booking.update({
      where: { id: bookingId },
      data: { checkinRequested: true, locationVerified },
    });

    track('checkin_requested', customerId, {
      booking_id: bookingId, gym_id: booking.gymId, location_verified: locationVerified, city: gymCity,
    });

    return { bookingId, locationVerified };
  } catch (err) {
    if (err.error) throw err;
    throw { status: 500, error: err.message || 'Server error' };
  }
}

export async function getCustomerBookings(customerId) {
  try {
    let bookings = (await prisma.booking.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' }
    })).map(normalizeBookingMoney);

    // Self-heal: a booking stuck at `pending` (process died between
    // reserving the slot and confirming payment) gets resolved the next
    // time the customer views their bookings — confirmed if they were
    // actually charged, released otherwise. See reconcileStalePendingBooking.
    const staleIds = new Set(bookings.filter(isStalePending).map((b) => b.id));
    if (staleIds.size) {
      const staleBookings = bookings.filter((b) => staleIds.has(b.id));
      const resolved = await Promise.all(staleBookings.map((b) => reconcileStalePendingBooking(b).catch(() => b)));
      const resultById = new Map(resolved.map((r, i) => [staleBookings[i].id, r]));
      bookings = bookings
        .filter((b) => !staleIds.has(b.id) || resultById.get(b.id))
        .map((b) => (staleIds.has(b.id) ? resultById.get(b.id) : b));
    }

    // Enrich with gym details so the customer sees gym names (not "Gym #id").
    // Fetch each unique gym once; best-effort — a gym lookup failure leaves that field null.
    const uniqueGymIds = [...new Set(bookings.map(b => b.gymId))];
    const gymMap = {};
    await Promise.all(uniqueGymIds.map(async (gymId) => {
      try {
        const resp = await fetch(`${GYM_SERVICE_URL}/internal/${gymId}`, {
          headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(GYM_SERVICE_URL)) }
        });
        if (resp.ok) {
          const body = await resp.json();
          const gym = body.data || body;
          gymMap[gymId] = {
            id: gym.id,
            name: gym.name,
            address: gym.address,
            city: gym.city,
            imageUrl: gym.images?.[0]?.url || null,
          };
        }
      } catch (_) { /* leave gym undefined for this id */ }
    }));

    // Strip the partner's internal override note — it's about the customer,
    // not for them (e.g. "phone dead, verified manually"). Every booking gets
    // a signed check-in token regardless of status — verifyAttendance's own
    // status/date checks are what actually gate a successful scan.
    return bookings.map(b => {
      const { attendanceOverrideReason, ...safe } = b;
      return { ...safe, gym: gymMap[b.gymId] || null, qrToken: signQrToken(b.id, b.gymId) };
    });
  } catch (err) {
    console.error('getCustomerBookings error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

// Internal: booking counts per slot start time for a gym on a given date.
// Used by gym-service to hide slots that have reached capacity.
export async function getSlotCounts(gymId, date) {
  const bookings = await prisma.booking.findMany({
    where: { gymId, date, status: { not: 'cancelled' } },
    select: { startTime: true },
  });
  const counts = {};
  for (const b of bookings) {
    counts[b.startTime] = (counts[b.startTime] || 0) + 1;
  }
  return counts;
}

export async function getGymBookings(gymId, partnerId) {
  try {
    // Verify partner owns this gym before exposing bookings
    let gym;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      gym = gymRes.data?.data || gymRes.data;
    } catch (_) {
      throw { status: 404, error: 'Gym not found' };
    }
    if (!gym || gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

    let bookings = await prisma.booking.findMany({
      where: { gymId },
      orderBy: { createdAt: 'desc' }
    });
    bookings = bookings.map(normalizeBookingMoney);

    // Enrich with customer name + photo so partner sees a real person, not
    // just "Member #123". Phone is deliberately excluded — partners must
    // never see a customer's phone number.
    const uniqueCustomerIds = [...new Set(bookings.map(b => b.customerId))];
    const customerMap = {};
    if (uniqueCustomerIds.length) {
      try {
        const batchRes = await axios.post(
          `${AUTH_SERVICE_URL}/internal/users/batch`,
          { ids: uniqueCustomerIds },
          await internalHeadersFor(AUTH_SERVICE_URL),
        );
        const users = batchRes.data?.data || [];
        for (const u of users) {
          customerMap[u.id] = { name: u.name || null, photoUrl: u.profileImageUrl || null };
        }
      } catch (_) { /* leave customerMap empty — graceful degradation */ }
    }

    // slotShiftWarning is customer-facing only — a partner already saw and
    // confirmed the shift at scan time, and must never see a "warning" tally
    // against a customer here.
    return bookings.map(b => {
      const { slotShiftWarning, ...safe } = b;
      return {
        ...safe,
        customerName: customerMap[b.customerId]?.name ?? null,
        customerPhotoUrl: customerMap[b.customerId]?.photoUrl ?? null,
      };
    });
  } catch (err) {
    if (err.error) throw err;
    console.error('getGymBookings error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function confirmBooking(bookingId, gymId, partnerId) {
  try {
    // 1. Find booking
    const booking = normalizeBookingMoney(await prisma.booking.findUnique({
      where: { id: bookingId }
    }));

    if (!booking) {
      throw {
        status: 404,
        error: 'Booking not found'
      };
    }

    // 2. Verify booking belongs to gym
    if (booking.gymId !== gymId) {
      throw {
        status: 403,
        error: 'Forbidden'
      };
    }

    // 3. Verify partner owns this gym
    let gym;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      gym = gymRes.data?.data || gymRes.data;
    } catch (_) {
      throw { status: 404, error: 'Gym not found' };
    }
    if (!gym || gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

    // 4. Verify status is 'pending'
    if (booking.status !== 'pending') {
      throw {
        status: 400,
        error: booking.status === 'confirmed'
          ? 'This booking is already confirmed'
          : `Booking cannot be confirmed (status: ${booking.status})`
      };
    }

    // 5. Atomically flip pending -> confirmed
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, status: 'pending' },
      data: { status: 'confirmed' },
    });
    if (count !== 1) {
      throw {
        status: 400,
        error: 'Booking cannot be confirmed'
      };
    }
    const confirmedBooking = normalizeBookingMoney(await prisma.booking.findUnique({ where: { id: bookingId } }));

    // 6. Fire notifications
    await notifyOnConfirmation(confirmedBooking, {
      customerId: booking.customerId,
      gymId,
      date: booking.date,
      startTime: booking.startTime,
      subscriptionId: booking.subscriptionId,
      city: gym.city,
    });

    return confirmedBooking;
  } catch (err) {
    if (err.error) throw err;
    console.error('confirmBooking error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function getGymSalesSummary(gymId, partnerId) {
  try {
    // Verify partner owns this gym before exposing revenue data
    let gym;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      gym = gymRes.data?.data || gymRes.data;
    } catch (_) {
      throw { status: 404, error: 'Gym not found' };
    }
    if (!gym || gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

    const today = new Date();
    // All buckets key off the session `date` (YYYY-MM-DD string) for consistency.
    // YYYY-MM-DD sorts lexicographically, so string >= comparisons are valid date ranges.
    const toDateString = (d) => d.toISOString().split('T')[0];
    const todayString = toDateString(today);
    const weekAgoString = toDateString(new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000));
    const monthAgoString = toDateString(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000));
    const yearAgoString = toDateString(new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000));

    // One fetch, bucketed in JS — cheaper than 5 near-identical aggregate
    // queries, and (more importantly) lets `net` be summed from each
    // booking's own stored `partnerShare` — the exact figure completeBooking
    // actually credited — instead of re-deriving an approximate net by
    // applying today's flat BOOKING_COMMISSION_PERCENT to the gross sum.
    // That approximation drifted from the real wallet balance two ways: a
    // booking's snapshotted commissionPct can differ from the CURRENT
    // percent if it's ever changed, and subscription-covered bookings
    // (subscriptionId set) get ZERO wallet credit at completion — the
    // partner was already paid upfront at subscription purchase — so
    // lumping their gross amount into a flat 80%-of-everything formula
    // overstated `net` relative to what actually landed in the wallet.
    const bookings = await prisma.booking.findMany({
      where: { gymId, status: 'completed' },
      select: { date: true, amount: true, partnerShare: true, subscriptionId: true },
    });

    function bucketFor(predicate) {
      const rows = bookings.filter(predicate);
      const gross = rows.reduce((sum, b) => sum + Number(b.amount), 0);
      const net = rows.reduce((sum, b) => {
        if (b.subscriptionId) return sum; // paid out at subscription purchase, not here
        const share = b.partnerShare != null
          ? Number(b.partnerShare)
          : Number(b.amount) * (1 - BOOKING_COMMISSION_PERCENT / 100); // legacy rows predating partnerShare
        return sum + share;
      }, 0);
      return {
        count: rows.length,
        total: Math.round(gross * 100) / 100,
        net: Math.round(net * 100) / 100,
      };
    }

    return {
      today: bucketFor((b) => b.date === todayString),
      weekly: bucketFor((b) => b.date >= weekAgoString),
      monthly: bucketFor((b) => b.date >= monthAgoString),
      yearly: bucketFor((b) => b.date >= yearAgoString),
      lifetime: bucketFor(() => true),
      commissionPct: BOOKING_COMMISSION_PERCENT
    };
  } catch (err) {
    if (err.error) throw err;
    console.error('getGymSalesSummary error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

function attendanceDateBuckets() {
  const today = new Date();
  const toDateString = (d) => d.toISOString().split('T')[0];
  return {
    todayString: toDateString(today),
    weekAgoString: toDateString(new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)),
    monthAgoString: toDateString(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)),
    yearAgoString: toDateString(new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000)),
  };
}

// Unlike getGymSalesSummary (which only ever counts `completed` bookings —
// inherently already in the past), "booked" here includes still-`confirmed`
// sessions, so each bucket's upper bound must be capped at today — otherwise
// future confirmed bookings would wrongly inflate the no-show count.
async function attendanceBucket(where) {
  const [booked, scanned, selfCheckin, manualVerify, manualOverride] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.count({ where: { ...where, attendanceMethod: 'qr_scan' } }),
    prisma.booking.count({ where: { ...where, attendanceMethod: 'qr_geofence_self' } }),
    prisma.booking.count({ where: { ...where, attendanceMethod: 'manual_verify' } }),
    prisma.booking.count({ where: { ...where, attendanceMethod: 'manual_override' } }),
  ]);
  const verified = scanned + selfCheckin + manualVerify + manualOverride;
  const noShow = booked - verified;
  return {
    booked, scanned, selfCheckin, manualVerify, manualOverride, noShow,
    verifiedAttendanceRate: booked ? scanned / booked : null,
    completionRate: booked ? verified / booked : null,
  };
}

export async function getGymAttendanceSummary(gymId, partnerId) {
  try {
    let gym;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      gym = gymRes.data?.data || gymRes.data;
    } catch (_) {
      throw { status: 404, error: 'Gym not found' };
    }
    if (!gym || gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

    const { todayString, weekAgoString, monthAgoString, yearAgoString } = attendanceDateBuckets();
    const bookedStatuses = { in: ['confirmed', 'started', 'completed'] };
    const [today, weekly, monthly, yearly] = await Promise.all([
      attendanceBucket({ gymId, date: { gte: todayString, lte: todayString }, status: bookedStatuses }),
      attendanceBucket({ gymId, date: { gte: weekAgoString, lte: todayString }, status: bookedStatuses }),
      attendanceBucket({ gymId, date: { gte: monthAgoString, lte: todayString }, status: bookedStatuses }),
      attendanceBucket({ gymId, date: { gte: yearAgoString, lte: todayString }, status: bookedStatuses }),
    ]);
    return { today, weekly, monthly, yearly };
  } catch (err) {
    if (err.error) throw err;
    console.error('getGymAttendanceSummary error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}

// First gobhi-gated routes in booking-service. gymId is optional — omitted
// means platform-wide.
export async function getAdminAttendanceSummary(gymId) {
  try {
    const { todayString, weekAgoString, monthAgoString, yearAgoString } = attendanceDateBuckets();
    const bookedStatuses = { in: ['confirmed', 'started', 'completed'] };
    const base = gymId ? { gymId } : {};
    const [today, weekly, monthly, yearly] = await Promise.all([
      attendanceBucket({ ...base, date: { gte: todayString, lte: todayString }, status: bookedStatuses }),
      attendanceBucket({ ...base, date: { gte: weekAgoString, lte: todayString }, status: bookedStatuses }),
      attendanceBucket({ ...base, date: { gte: monthAgoString, lte: todayString }, status: bookedStatuses }),
      attendanceBucket({ ...base, date: { gte: yearAgoString, lte: todayString }, status: bookedStatuses }),
    ]);
    return { today, weekly, monthly, yearly };
  } catch (err) {
    if (err.error) throw err;
    console.error('getAdminAttendanceSummary error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}

// Per-gym breakdown for admin triage (spot problem gyms by no-show rate).
// Uses groupBy rather than looping attendanceBucket once per gym — that
// per-bucket-aggregate-call style is fine at "one partner's one gym" scale
// (getGymAttendanceSummary/getGymSalesSummary) but would be an N+1 query
// pattern run across every gym on the platform.
export async function getAdminAttendanceByGym(period = 'monthly') {
  try {
    const { todayString, weekAgoString, monthAgoString, yearAgoString } = attendanceDateBuckets();
    const fromDateString = { today: todayString, weekly: weekAgoString, monthly: monthAgoString, yearly: yearAgoString }[period] || monthAgoString;

    const where = { date: { gte: fromDateString, lte: todayString }, status: { in: ['confirmed', 'started', 'completed'] } };
    const [bookedGroups, methodGroups] = await Promise.all([
      prisma.booking.groupBy({ by: ['gymId'], where, _count: true }),
      prisma.booking.groupBy({ by: ['gymId', 'attendanceMethod'], where, _count: true }),
    ]);

    const methodByGym = {};
    for (const row of methodGroups) {
      methodByGym[row.gymId] = methodByGym[row.gymId] || {};
      methodByGym[row.gymId][row.attendanceMethod || 'none'] = row._count;
    }

    const rows = bookedGroups.map((g) => {
      const methods = methodByGym[g.gymId] || {};
      const scanned = methods.qr_scan || 0;
      const selfCheckin = methods.qr_geofence_self || 0;
      const manualVerify = methods.manual_verify || 0;
      const manualOverride = methods.manual_override || 0;
      const booked = g._count;
      const verified = scanned + selfCheckin + manualVerify + manualOverride;
      return {
        gymId: g.gymId,
        booked,
        scanned,
        selfCheckin,
        manualVerify,
        manualOverride,
        noShow: booked - verified,
        verifiedAttendanceRate: booked ? scanned / booked : null,
      };
    });
    rows.sort((a, b) => b.noShow - a.noShow);
    return rows;
  } catch (err) {
    console.error('getAdminAttendanceByGym error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}

// Streak/calendar logic is deliberately left client-side — "what counts as
// a day", timezone, and grace-period rules are exactly the kind of thing
// that shouldn't be locked into the API prematurely. This just returns raw
// facts (totals + recent attended dates) for a client to compute with.
export async function getCustomerAttendanceSummary(customerId) {
  try {
    const { todayString } = attendanceDateBuckets();
    const monthStart = `${todayString.slice(0, 7)}-01`;
    const [totalAttended, thisMonthAttended, recent] = await Promise.all([
      prisma.booking.count({ where: { customerId, attendedAt: { not: null } } }),
      prisma.booking.count({ where: { customerId, attendedAt: { not: null }, date: { gte: monthStart } } }),
      prisma.booking.findMany({
        where: { customerId, attendedAt: { not: null } },
        orderBy: { attendedAt: 'desc' },
        take: 90,
        select: { date: true, gymId: true, attendedAt: true },
      }),
    ]);
    return {
      totalAttended,
      thisMonthAttended,
      lastAttendedAt: recent[0]?.attendedAt ?? null,
      attendedDates: recent.map((r) => r.date),
    };
  } catch (err) {
    console.error('getCustomerAttendanceSummary error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}

// Customer-facing warning log — one row per early-scan confirmation (see
// verifyAttendance's SLOT_TIME_MISMATCH branch). Never surfaced to
// partners/admin.
export async function getMyAttendanceWarnings(customerId) {
  try {
    const warnings = await prisma.attendanceWarning.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });

    const uniqueGymIds = [...new Set(warnings.map((w) => w.gymId))];
    const gymNameById = {};
    await Promise.all(uniqueGymIds.map(async (gymId) => {
      try {
        const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
        const gym = gymRes.data?.data || gymRes.data;
        gymNameById[gymId] = gym?.name || null;
      } catch (_) { /* leave gym name null for this id */ }
    }));

    return {
      count: warnings.length,
      warnings: warnings.map((w) => ({
        bookingId: w.bookingId,
        gymId: w.gymId,
        gymName: gymNameById[w.gymId] ?? null,
        date: w.date,
        originalStartTime: w.originalStartTime,
        originalEndTime: w.originalEndTime,
        newStartTime: w.newStartTime,
        newEndTime: w.newEndTime,
        createdAt: w.createdAt,
      })),
    };
  } catch (err) {
    console.error('getMyAttendanceWarnings error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}

// Public, unauthenticated — marketing-site aggregate stat only. Zero PII:
// no customerId/gymId breakdown, just a platform-wide count.
export async function getPublicAttendanceStats() {
  try {
    const { todayString } = attendanceDateBuckets();
    const monthStart = `${todayString.slice(0, 7)}-01`;
    const sessionsAttendedThisMonth = await prisma.booking.count({
      where: { attendedAt: { not: null }, date: { gte: monthStart } },
    });
    return { sessionsAttendedThisMonth, month: todayString.slice(0, 7) };
  } catch (err) {
    console.error('getPublicAttendanceStats error:', err);
    throw { status: 500, error: err.message || 'Server error' };
  }
}
