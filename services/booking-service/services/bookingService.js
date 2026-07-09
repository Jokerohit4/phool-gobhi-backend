import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { notifyPartner } from '../utils/notifyPartner.js';
import { notifyCustomer } from '../utils/notifyCustomer.js';
import { track } from '../utils/analytics.js';
import { isSlotInPastOrTooSoon } from '../utils/slotTiming.js';

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
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Shared header for service-to-service wallet mutations (credit/debit are internal-only)
const internalHeaders = { headers: { 'x-internal-key': INTERNAL_API_KEY } };

export async function createBooking(customerId, { gymId, date, startTime, endTime }) {
  try {
    // 1. Fetch gym details from gym-service
    let gym;
    try {
      const response = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, internalHeaders);
      gym = response.data.data || response.data;
    } catch (err) {
      throw {
        status: 404,
        error: 'Gym not found'
      };
    }

    const capacity = gym.capacity;
    const amount = gym.sessionPrice;

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
      const profileRes = await axios.get(`${AUTH_SERVICE_URL}/internal/${customerId}`, internalHeaders);
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
        `${GYM_SERVICE_URL}/${gymId}/blocks?date=${date}`
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

    // 2. Count existing non-cancelled bookings for this slot
    const bookingCount = await prisma.booking.count({
      where: {
        gymId,
        date,
        startTime,
        status: {
          not: 'cancelled'
        }
      }
    });

    // 3. Check if slot is full
    if (bookingCount >= capacity) {
      track('booking_failed', customerId, { gym_id: gymId, reason: 'slot_full', date, start_time: startTime });
      throw {
        status: 409,
        error: 'Slot is full'
      };
    }

    // 4. Debit customer wallet
    try {
      await axios.post(`${WALLET_SERVICE_URL}/${customerId}/debit`, {
        amount,
        description: 'Gym session booking'
      }, internalHeaders);
    } catch (err) {
      track('booking_failed', customerId, { gym_id: gymId, reason: 'insufficient_balance', amount });
      throw {
        status: 400,
        error: err.response?.data?.error || 'Insufficient wallet balance'
      };
    }

    // 5. Create and return booking record
    const booking = await prisma.booking.create({
      data: {
        customerId,
        gymId,
        date,
        startTime,
        endTime,
        amount,
        status: 'confirmed'
      }
    });

    // Money funnel: booking created and paid (wallet debited) in one synchronous step.
    track('booking_confirmed', customerId, {
      booking_id: booking.id, gym_id: gymId, amount, date, start_time: startTime,
    });

    // 6. Fire-and-forget notifications — never block booking creation
    notifyPartner(gymId, booking).catch(() => {});
    notifyCustomer(customerId, {
      title: 'Booking confirmed',
      body: `Your session on ${booking.date} at ${booking.startTime} is booked. ₹${booking.amount} debited.`,
      data: { type: 'booking_confirmed', bookingId: booking.id, date: booking.date },
    }).catch(() => {});

    return booking;
  } catch (err) {
    if (err.error) throw err;
    console.error('createBooking error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function cancelBooking(bookingId, customerId) {
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

    // 2. Verify booking belongs to customer
    if (booking.customerId !== customerId) {
      throw {
        status: 403,
        error: 'Forbidden'
      };
    }

    // 3. Verify status is 'confirmed'
    if (booking.status !== 'confirmed') {
      throw {
        status: 400,
        error: 'Booking cannot be cancelled'
      };
    }

    // 4. Credit wallet
    try {
      await axios.post(`${WALLET_SERVICE_URL}/${customerId}/credit`, {
        amount: booking.amount,
        description: 'Booking cancellation refund'
      }, internalHeaders);
    } catch (err) {
      throw {
        status: 400,
        error: err.response?.data?.error || 'Failed to process refund'
      };
    }

    // 5. Update booking status to 'cancelled'
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'cancelled' }
    });

    track('booking_cancelled', customerId, {
      booking_id: booking.id, gym_id: booking.gymId, amount: booking.amount, date: booking.date,
    });

    notifyCustomer(customerId, {
      title: 'Booking cancelled',
      body: `Your session on ${booking.date} was cancelled. ₹${booking.amount} refunded to your wallet.`,
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
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, internalHeaders);
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

    // 7. Credit partner wallet — best-effort, never blocks completion
    try {
      if (gym.partnerId) {
        await axios.post(`${WALLET_SERVICE_URL}/${gym.partnerId}/credit`, {
          amount: booking.amount,
          description: 'Gym session payout'
        }, internalHeaders);
      }
    } catch (payoutErr) {
      console.error('Partner payout failed for booking', bookingId, payoutErr.message);
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
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${booking.gymId}`, internalHeaders);
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
    const bookings = await prisma.booking.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' }
    });

    // Enrich with gym details so the customer sees gym names (not "Gym #id").
    // Fetch each unique gym once; best-effort — a gym lookup failure leaves that field null.
    const uniqueGymIds = [...new Set(bookings.map(b => b.gymId))];
    const gymMap = {};
    await Promise.all(uniqueGymIds.map(async (gymId) => {
      try {
        const resp = await fetch(`${GYM_SERVICE_URL}/internal/${gymId}`, {
          headers: { 'x-internal-key': INTERNAL_API_KEY }
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
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, internalHeaders);
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
      const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, internalHeaders);
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
