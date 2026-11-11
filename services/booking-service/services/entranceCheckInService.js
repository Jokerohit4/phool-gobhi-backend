import { describeUpcomingBooking } from '../utils/upcomingBooking.js';

// One poster, three behaviours, resolved from server records:
//
//   1. The customer has a usable booking  -> booking check-in (unchanged rules).
//   2. The customer is an approved member -> member attendance.
//   3. Neither, and no booking at all     -> they can ask to join:
//        - a scan alone never links anyone (MEMBERSHIP_REQUIRED: a pay-per-
//          session guest who scans the poster must not silently become a member);
//        - with `join` (their explicit tap) the server first proves presence
//          (inside the gym's geofence), then asks auth-service to link them.
//          If the owner's "approve every join" window is open they are approved
//          and checked in by the same request; otherwise a pending request is
//          created and the answer is MEMBERSHIP_PENDING — no attendance, no
//          billable membership, until the gym approves.
//
// A member the gym removed stays blocked (MEMBERSHIP_BLOCKED); a scan can never
// override the owner. MEMBERSHIP_PENDING is also what an already-pending
// customer gets on any later scan, so the client shows "waiting for the gym"
// rather than asking them to join again.
export async function resolveEntranceCheckIn({ gymId, customerId, lat, lng, confirmEarly = false, join = false }, deps) {
  if (!Number.isInteger(gymId) || gymId <= 0) {
    throw { status: 400, code: 'INVALID_GYM', error: 'A valid gym is required' };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw { status: 400, code: 'LOCATION_REQUIRED', error: 'A valid location is required to check in' };
  }
  let bookingError;
  try {
    const result = await deps.selfCheckIn(gymId, customerId, lat, lng, confirmEarly);
    return { ...result, kind: 'booking' };
  } catch (err) {
    // Preserve early-confirmation, location, payment and server errors. Only
    // an absent/currently unusable booking can fall through to membership.
    if (!['NO_ACTIVE_BOOKING', 'BOOKING_PENDING_CONFIRMATION', 'SESSION_ENDED', 'SESSION_ALREADY_COMPLETED'].includes(err.code)) throw err;
    bookingError = err;
  }
  let memberError;
  try {
    return memberResult(await deps.memberCheckIn(gymId, customerId, lat, lng), false);
  } catch (err) {
    // NOT_LINKED_GYM: never linked. MEMBERSHIP_PENDING: asked, gym hasn't
    // approved yet. Anything else (TOO_FAR, server errors) is surfaced as is.
    if (err.code !== 'NOT_LINKED_GYM' && err.code !== 'MEMBERSHIP_PENDING') throw err;
    memberError = err;
  }

  // Keep useful booking messages (session ended, awaiting confirmation, ...):
  // someone with a booking is a guest here, not asking to become a member.
  if (bookingError.code !== 'NO_ACTIVE_BOOKING') throw bookingError;
  // ...and that holds for a booking that is not usable right now too (one for
  // tomorrow, or later today): they are a guest, so no request is ever raised for
  // them, not even if the client asks for one. They are told about the booking
  // instead ("Your session is tomorrow at 7:00 PM."). Only someone who has never
  // linked is covered: a request already made is left to run its course.
  if (memberError.code === 'NOT_LINKED_GYM') {
    const booking = await deps.nextLiveBookingAtGym(customerId, gymId);
    if (booking) {
      throw { status: 409, code: 'UPCOMING_BOOKING', error: describeUpcomingBooking(booking), booking };
    }
  }
  if (!join) {
    if (memberError.code === 'MEMBERSHIP_PENDING') throw membershipPending();
    throw { status: 403, code: 'MEMBERSHIP_REQUIRED',
      error: 'No booking for right now and not a member of this gym yet. Ask to join to check in.' };
  }

  await deps.assertAtGym(gymId, lat, lng);
  const membership = await deps.joinGymViaQr(customerId, gymId);
  if (membership.status !== 'approved') throw membershipPending();
  return memberResult(await deps.memberCheckIn(gymId, customerId, lat, lng), membership.joined === true);
}

function membershipPending() {
  return { status: 403, code: 'MEMBERSHIP_PENDING',
    error: "Your request is with the gym. You'll be checked in once they approve, and we'll notify you." };
}

function memberResult(result, joined) {
  return { ...result, kind: 'member', joined, attendedAt: result.checkedInAt,
    attendanceMethod: 'member_geofence', alreadyVerified: !!result.alreadyCheckedIn };
}
