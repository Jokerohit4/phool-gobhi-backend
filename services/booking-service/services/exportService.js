import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// DPDPA access right (s.11) for bookings, called by auth-service's
// platform-wide export.
//
// Booking-service has no erasure counterpart, and that asymmetry is the point
// worth understanding rather than filing as an inconsistency. These rows are
// part of a financial and partner-settlement record with statutory retention,
// so they survive account deletion - and because they survive, the person
// they describe keeps the right to see them. An access right that skipped
// exactly the data we refuse to delete would be the wrong way round.
export async function buildExportService(userId) {
  const [bookings, warnings, memberAttendance] = await Promise.all([
    prisma.booking.findMany({ where: { customerId: userId }, orderBy: { createdAt: 'asc' } }),
    prisma.attendanceWarning.findMany({ where: { customerId: userId }, orderBy: { createdAt: 'asc' } }),
    prisma.memberAttendance.findMany({ where: { customerId: userId }, orderBy: { checkedInAt: 'asc' } }),
  ]);

  return {
    bookings: bookings.map((b) => ({
      bookingId: b.id,
      gymId: b.gymId,
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
      amount: Number(b.amount),
      status: b.status,
      isAttendanceSaas: b.isAttendanceSaas,
      classId: b.classId,
      subscriptionId: b.subscriptionId,
      attendedAt: b.attendedAt,
      attendanceMethod: b.attendanceMethod,
      locationVerified: b.locationVerified,
      slotShiftWarning: b.slotShiftWarning,
      cancellationReason: b.cancellationReason,
      nextVisitIntent: b.nextVisitIntent,
      bookedAt: b.createdAt,
    })),
    // Early-scan warnings are a judgement recorded ABOUT this person, which
    // makes them exactly the kind of thing an access right exists to surface.
    attendanceWarnings: warnings.map((w) => ({
      at: w.createdAt,
      bookingId: w.bookingId,
      gymId: w.gymId,
      date: w.date,
      bookedSlot: `${w.originalStartTime}-${w.originalEndTime}`,
      shiftedSlot: `${w.newStartTime}-${w.newEndTime}`,
    })),
    // Attendance-SaaS check-ins that never had a booking behind them.
    memberCheckins: memberAttendance.map((m) => ({ at: m.checkedInAt, gymId: m.gymId, date: m.date })),
    // Commission and partner-share figures are deliberately omitted: they are
    // the gym's commercial terms, not the customer's personal data. The
    // amount the customer actually paid is included above.
    notIncluded: {
      partnerCommercials: 'commission percentage and partner share are the gym\'s business terms, not your personal data',
    },
  };
}
