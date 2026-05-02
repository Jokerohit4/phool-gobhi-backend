import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';

export async function createBooking(customerId, { gymId, date, startTime, endTime, amount }) {
  try {
    // 1. Fetch gym details from gym-service
    let gym;
    try {
      const response = await axios.get(`${GYM_SERVICE_URL}/api/gyms/${gymId}`);
      gym = response.data.data || response.data;
    } catch (err) {
      throw {
        status: 404,
        error: 'Gym not found'
      };
    }

    const capacity = gym.capacity;

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
      throw {
        status: 409,
        error: 'Slot is full'
      };
    }

    // 4. Debit customer wallet
    try {
      await axios.post(`${WALLET_SERVICE_URL}/api/wallet/${customerId}/debit`, {
        amount,
        description: 'Gym session booking'
      });
    } catch (err) {
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

    return booking;
  } catch (err) {
    if (err.status) throw err;
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
      await axios.post(`${WALLET_SERVICE_URL}/api/wallet/${customerId}/credit`, {
        amount: booking.amount,
        description: 'Booking cancellation refund'
      });
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

    // 6. Return updated booking
    return updatedBooking;
  } catch (err) {
    if (err.status) throw err;
    console.error('cancelBooking error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function completeBooking(bookingId, gymId) {
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

    // 4. Update status to 'completed'
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'completed' }
    });

    return updatedBooking;
  } catch (err) {
    if (err.status) throw err;
    console.error('completeBooking error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function getCustomerBookings(customerId) {
  try {
    const bookings = await prisma.booking.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' }
    });
    return bookings;
  } catch (err) {
    console.error('getCustomerBookings error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function getGymBookings(gymId) {
  try {
    const bookings = await prisma.booking.findMany({
      where: { gymId },
      orderBy: { createdAt: 'desc' }
    });
    return bookings;
  } catch (err) {
    console.error('getGymBookings error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}

export async function getGymSalesSummary(gymId) {
  try {
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];

    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const yearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);

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
        createdAt: { gte: weekAgo },
        status: 'completed'
      },
      _count: true,
      _sum: { amount: true }
    });

    // Get monthly stats
    const monthlyStats = await prisma.booking.aggregate({
      where: {
        gymId,
        createdAt: { gte: monthAgo },
        status: 'completed'
      },
      _count: true,
      _sum: { amount: true }
    });

    // Get yearly stats
    const yearlyStats = await prisma.booking.aggregate({
      where: {
        gymId,
        createdAt: { gte: yearAgo },
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
    console.error('getGymSalesSummary error:', err);
    throw {
      status: 500,
      error: err.message || 'Server error'
    };
  }
}
