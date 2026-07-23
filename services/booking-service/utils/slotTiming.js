const IST_OFFSET_MS = (5 * 60 + 30) * 60000;
const MIN_LEAD_MS = 60 * 60000;

// Gym hours ("14:00") are wall-clock IST regardless of the server's own
// timezone. Convert the requested date+time — treated as IST — to the
// UTC instant it actually represents, so this compares correctly across
// midnight/month/year boundaries instead of comparing date strings and
// time-of-day separately.
function slotInstantUTC(date, startTime) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = startTime.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;
}

// A slot is bookable only if it starts at least MIN_LEAD_MS from now.
export function isSlotInPastOrTooSoon(date, startTime) {
  return slotInstantUTC(date, startTime) < Date.now() + MIN_LEAD_MS;
}

// How many hours from now until this slot starts — used by cancelBooking's
// tiered refund policy. Negative once the slot has already started.
export function hoursUntilSlot(date, startTime) {
  return (slotInstantUTC(date, startTime) - Date.now()) / 3600000;
}

const SELF_CHECKIN_EARLY_GRACE_MS = 15 * 60000;

// Is `now` within this session's window — used by the poster-QR/geofence
// self-check-in flow to find "the booking the customer means right now"
// from a gym-level (not booking-level) scan. Allows checking in up to 15
// minutes before the session starts (queueing/changing at the gym) through
// to the scheduled end time.
export function isSessionActiveNow(date, startTime, endTime) {
  const start = slotInstantUTC(date, startTime);
  const end = slotInstantUTC(date, endTime);
  const now = Date.now();
  return now >= start - SELF_CHECKIN_EARLY_GRACE_MS && now <= end;
}
