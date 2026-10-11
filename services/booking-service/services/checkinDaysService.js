import { PrismaClient } from '@prisma/client';
import { IST_OFFSET_MS } from '../utils/slotTiming.js';

// Coach-journey B3: the "showed-up day" source of truth. Health-service's
// journey (steady weeks, showed-up days, layer unlocks) must count a day the
// customer showed up ONCE, whichever of the three check-in surfaces produced
// it — a verified Booking, a booking-free MemberAttendance (attendance-SaaS
// linked member) or an IndependentCheckIn (non-partner gym). Kept in its own
// module (not bookingService.js) so the union logic is testable without
// standing up that file's entire mock surface.
const prisma = new PrismaClient();

// Booking.attendedAt is a UTC instant; the day it "happened on" is the IST
// calendar day (slotTiming.js convention — booking.date is always IST too,
// but the contract pins the day to the instant attendance was verified,
// which is what a late-night scan or early-slot shift actually was).
function istDayOf(instant) {
  return new Date(new Date(instant).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// The UTC instant the IST calendar day `day` ("YYYY-MM-DD") begins — the
// exact SQL bound for "this IST day onwards" on a timestamp column.
function istDayStartUtc(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
}

// Distinct union of the customer's check-in days, ascending, as
// "YYYY-MM-DD". `from` ("YYYY-MM-DD") bounds the days returned; null means
// every day on record. MemberAttendance/IndependentCheckIn store the IST
// date directly, so their `from` bound is a plain string compare; Booking
// is bounded by converting `from` to the instant that IST day begins.
export async function getDays(customerId, from = null) {
  const [attendedBookings, memberCheckins, independentCheckins] = await Promise.all([
    prisma.booking.findMany({
      where: {
        customerId,
        attendedAt: { not: null, ...(from ? { gte: istDayStartUtc(from) } : {}) },
      },
      select: { attendedAt: true },
    }),
    prisma.memberAttendance.findMany({
      where: { customerId, ...(from ? { date: { gte: from } } : {}) },
      select: { date: true },
    }),
    prisma.independentCheckIn.findMany({
      where: { customerId, ...(from ? { date: { gte: from } } : {}) },
      select: { date: true },
    }),
  ]);

  const days = new Set();
  for (const b of attendedBookings) days.add(istDayOf(b.attendedAt));
  for (const r of memberCheckins) days.add(r.date);
  for (const r of independentCheckins) days.add(r.date);
  return Array.from(days).sort();
}

// The customer's most recent check-in instant across all three sources, or
// null if they have never checked in anywhere. getCustomerAttendanceSummary
// surfaces this as lastAttendedAt, which used to be Booking.attendedAt only
// — a linked member who has never booked must not show "No sessions yet".
export async function getLatestCheckInAt(customerId) {
  const [latestBooking, latestMember, latestIndependent] = await Promise.all([
    prisma.booking.findFirst({
      where: { customerId, attendedAt: { not: null } },
      orderBy: { attendedAt: 'desc' },
      select: { attendedAt: true },
    }),
    prisma.memberAttendance.findFirst({
      where: { customerId },
      orderBy: { checkedInAt: 'desc' },
      select: { checkedInAt: true },
    }),
    prisma.independentCheckIn.findFirst({
      where: { customerId },
      orderBy: { checkedInAt: 'desc' },
      select: { checkedInAt: true },
    }),
  ]);
  const instants = [latestBooking?.attendedAt, latestMember?.checkedInAt, latestIndependent?.checkedInAt]
    .filter(Boolean)
    .map((at) => new Date(at).getTime());
  return instants.length ? new Date(Math.max(...instants)) : null;
}
