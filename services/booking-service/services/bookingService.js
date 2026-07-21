import { PrismaClient, Prisma } from '@prisma/client';
import axios from 'axios';
import { notifyPartner } from '../utils/notifyPartner.js';
import { notifyCustomer } from '../utils/notifyCustomer.js';
import { track } from '../utils/analytics.js';
import { isSlotInPastOrTooSoon, hoursUntilSlot } from '../utils/slotTiming.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

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

// Per-target headers for service-to-service calls (x-internal-key shared
// secret, plus a Google ID token on Cloud Run — see utils/googleIdToken.js —
// now required since each target's Cloud Run invoker no longer allows
// anonymous callers). Computed per call since the ID token is fetched
// async (internally cached/refreshed, so this is cheap).
async function internalHeadersFor(targetUrl) {
  return { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(targetUrl)) } };
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
    return prisma.booking.update({ where: { id: booking.id }, data: { status: 'confirmed' } }).catch(() => null);
  }

  try {
    const res = await axios.get(
      `${WALLET_SERVICE_URL}/internal/transactions/by-key/${debitIdempotencyKey(booking.id)}`,
      await internalHeadersFor(WALLET_SERVICE_URL)
    );
    const wasCharged = !!res.data?.data;
    if (wasCharged) {
      return prisma.booking.update({ where: { id: booking.id }, data: { status: 'confirmed' } }).catch(() => null);
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
      return await prisma.$transaction(async (tx) => {
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
          data: { customerId, gymId, date, startTime, endTime, amount, status: 'pending', subscriptionId },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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

// Flips a reservation to `confirmed`, tracks the funnel event, and fires
// notifications. Shared by createBooking's normal path and its
// debit-call-error recovery path (where the debit turned out to have
// actually landed despite the call throwing) so both stay in sync.
async function confirmReservation(reservation, { customerId, gymId, date, startTime, subscriptionId }) {
  const booking = await prisma.booking.update({
    where: { id: reservation.id },
    data: { status: 'confirmed' },
  });

  track('booking_confirmed', customerId, {
    booking_id: booking.id, gym_id: gymId, amount: booking.amount, date, start_time: startTime,
    via: subscriptionId ? 'subscription' : 'wallet',
  });

  notifyPartner(gymId, booking).catch(() => {});
  notifyCustomer(customerId, {
    title: 'Booking confirmed',
    body: `Your session on ${booking.date} at ${booking.startTime} is booked. ₹${booking.amount} debited.`,
    data: { type: 'booking_confirmed', bookingId: booking.id, date: booking.date },
  }).catch(() => {});

  return booking;
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
        track('booking_failed', customerId, { gym_id: gymId, reason: 'slot_full', date, start_time: startTime });
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
          // reconcileStalePendingBooking will confirm it (never delete a
          // charged booking) once it's next looked at.
        }

        if (actuallyCharged) {
          return confirmReservation(reservation, { customerId, gymId, date, startTime, subscriptionId: null });
        }

        // Genuinely not charged — release the reservation so the slot goes
        // back to looking untouched.
        await prisma.booking.delete({ where: { id: reservation.id } }).catch(() => {});
        track('booking_failed', customerId, { gym_id: gymId, reason: 'insufficient_balance', amount });
        throw {
          status: 400,
          error: err.response?.data?.error || 'Insufficient wallet balance'
        };
      }
    }

    // 5-6. Payment succeeded (or wasn't needed) — confirm the reservation,
    // track the funnel event, and fire notifications.
    return confirmReservation(reservation, { customerId, gymId, date, startTime, subscriptionId });
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
// Mirrored (for display only, never trusted) on the website so it can show
// the applicable tier before the customer confirms — this function is the
// only place that actually decides the refund.
function cancellationRefundRate(hoursUntil) {
  if (hoursUntil < 1) return null; // too close to the session — cancellation blocked
  if (hoursUntil < 4) return 0.3;
  if (hoursUntil < 8) return 0.5;
  return 1.0;
}

export async function cancelBooking(bookingId, customerId) {
  try {
    // 1. Find booking
    let booking = await prisma.booking.findUnique({
      where: { id: bookingId }
    });

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

    // 2a. A booking stuck at `pending` (see reconcileStalePendingBooking) has
    // to be resolved before we can decide whether "cancel" even means
    // anything for it — we can't safely refund a booking we don't yet know
    // was actually charged.
    if (booking.status === 'pending') {
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

    // 2b. Tiered cancellation window: blocked inside 1 hour of the slot;
    // otherwise the refund rate depends on how much notice was given.
    // Checked before the status flip below — a blocked cancellation must
    // never touch the booking's status at all.
    const hoursUntil = hoursUntilSlot(booking.date, booking.startTime);
    const refundRate = cancellationRefundRate(hoursUntil);
    if (refundRate === null) {
      throw { status: 400, error: 'Bookings cannot be cancelled within 1 hour of the session' };
    }

    // 3-4. Atomically flip confirmed -> cancelled first, gating the refund on
    // this single conditional update succeeding. Previously the wallet
    // credit ran BEFORE this status flip: if the process crashed in between,
    // the booking was left `confirmed` but already refunded, and since
    // `status === 'confirmed'` was the only guard elsewhere, it could later
    // be completed (crediting the partner too) or cancelled again (a second
    // customer credit). `updateMany` + `count === 1` makes a concurrent
    // second cancel attempt no-op instead of double-crediting.
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, customerId, status: 'confirmed' },
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

export async function completeBooking(bookingId, gymId, partnerId) {
  try {
    // 1. Find booking
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId }
    });

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

    // 3. Verify status is 'confirmed'
    if (booking.status !== 'confirmed') {
      throw {
        status: 400,
        error: 'Booking cannot be completed'
      };
    }

    // 4. A session can only be completed on its own date — stops a scanned/forged
    //    booking ID from being marked complete on the wrong day.
    const todayString = new Date().toISOString().split('T')[0];
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

    // 6. Update status to 'completed'
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'completed' }
    });

    // 7. Credit partner wallet — best-effort, never blocks completion.
    // Skipped when this booking was covered by an active subscription: the
    // partner's share was already credited upfront at subscription purchase
    // (see wallet-service's fulfillSubscriptionPurchase) — crediting again
    // here would pay them twice for the same session.
    if (!booking.subscriptionId) {
      try {
        if (gym.partnerId) {
          await axios.post(`${WALLET_SERVICE_URL}/${gym.partnerId}/credit`, {
            amount: booking.amount,
            description: 'Gym session payout'
          }, await internalHeadersFor(WALLET_SERVICE_URL));
        }
      } catch (payoutErr) {
        console.error('Partner payout failed for booking', bookingId, payoutErr.message);
      }
    }

    // Fulfillment funnel: the session actually happened (partner verified at the gym).
    track('booking_completed', booking.customerId, {
      booking_id: booking.id, gym_id: gymId, amount: booking.amount, date: booking.date,
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

export async function requestCheckIn(bookingId, customerId, lat, lng) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw { status: 404, error: 'Booking not found' };
    if (booking.customerId !== customerId) throw { status: 403, error: 'Forbidden' };
    if (booking.status !== 'confirmed') throw { status: 400, error: 'Booking is not confirmed' };
    const todayString = new Date().toISOString().split('T')[0];
    if (booking.date !== todayString) throw { status: 400, error: 'This session is not scheduled for today' };

    let locationVerified = false;
    try {
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${booking.gymId}`, await internalHeadersFor(GYM_SERVICE_URL));
      const gym = gymRes.data.data || gymRes.data;
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
      booking_id: bookingId, gym_id: booking.gymId, location_verified: locationVerified,
    });

    return { bookingId, locationVerified };
  } catch (err) {
    if (err.error) throw err;
    throw { status: 500, error: err.message || 'Server error' };
  }
}

export async function getCustomerBookings(customerId) {
  try {
    let bookings = await prisma.booking.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' }
    });

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

    return bookings.map(b => ({ ...b, gym: gymMap[b.gymId] || null }));
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

    const bookings = await prisma.booking.findMany({
      where: { gymId },
      orderBy: { createdAt: 'desc' }
    });
    return bookings;
  } catch (err) {
    if (err.error) throw err;
    console.error('getGymBookings error:', err);
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

    // Get today's stats
    const todayStats = await prisma.booking.aggregate({
      where: {
        gymId,
        date: todayString,
        status: 'completed'
      },
      _count: true,
      _sum: { amount: true }
    });

    // Get weekly stats
    const weeklyStats = await prisma.booking.aggregate({
      where: {
        gymId,
        date: { gte: weekAgoString },
        status: 'completed'
      },
      _count: true,
      _sum: { amount: true }
    });

    // Get monthly stats
    const monthlyStats = await prisma.booking.aggregate({
      where: {
        gymId,
        date: { gte: monthAgoString },
        status: 'completed'
      },
      _count: true,
      _sum: { amount: true }
    });

    // Get yearly stats
    const yearlyStats = await prisma.booking.aggregate({
      where: {
        gymId,
        date: { gte: yearAgoString },
        status: 'completed'
      },
      _count: true,
      _sum: { amount: true }
    });

    return {
      today: {
        count: todayStats._count,
        total: todayStats._sum.amount || 0
      },
      weekly: {
        count: weeklyStats._count,
        total: weeklyStats._sum.amount || 0
      },
      monthly: {
        count: monthlyStats._count,
        total: monthlyStats._sum.amount || 0
      },
      yearly: {
        count: yearlyStats._count,
        total: yearlyStats._sum.amount || 0
      }
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
