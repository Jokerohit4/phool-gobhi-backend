// One poster, with eligibility resolved from server records. A failed booking
// check never creates a membership or records attendance for an unapproved user.
export async function resolveEntranceCheckIn({ gymId, customerId, lat, lng, confirmEarly = false }, deps) {
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
  try {
    const result = await deps.memberCheckIn(gymId, customerId, lat, lng);
    return { ...result, kind: 'member', attendedAt: result.checkedInAt,
      attendanceMethod: 'member_geofence', alreadyVerified: !!result.alreadyCheckedIn };
  } catch (err) {
    if (err.code === 'MEMBERSHIP_PENDING') throw err;
    if (err.code !== 'NOT_LINKED_GYM') throw err;
    // Keep useful booking messages. The client can offer a separate request
    // action; claiming a booking itself never becomes a membership request.
    if (bookingError.code !== 'NO_ACTIVE_BOOKING') throw bookingError;
    throw { status: 403, code: 'MEMBERSHIP_REQUIRED',
      error: 'No eligible booking or approved membership. If you are a member, request approval from the gym.' };
  }
}
