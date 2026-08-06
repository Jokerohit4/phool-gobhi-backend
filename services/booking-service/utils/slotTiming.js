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

// "Today" as an IST calendar date (YYYY-MM-DD), not the server's own (UTC)
// calendar date — `booking.date` is always an IST-local date string, so
// comparing it against a raw `new Date().toISOString()` date is wrong
// between IST 00:00-05:29, when the UTC date is still yesterday's.
export function todayDateStringIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().split('T')[0];
}

// A slot is bookable only if it starts at least MIN_LEAD_MS from now.
export function isSlotInPastOrTooSoon(date, startTime) {
  return slotInstantUTC(date, startTime) < Date.now() + MIN_LEAD_MS;
}

// Weekday (0=Sunday..6=Saturday) of a plain IST calendar-date string —
// timezone-invariant, since it only depends on the calendar date itself
// (India has no DST). Used to check a class booking's requested date
// against GymClass.dayOfWeek.
export function getDayOfWeek(date) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
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

// True only for the "too early" side of the window (more than 15 min before
// start) — used by verifyAttendance to offer a confirm-and-shift flow for
// early scans while still hard-rejecting scans after the session has ended.
export function isBeforeSessionWindow(date, startTime) {
  return Date.now() < slotInstantUTC(date, startTime) - SELF_CHECKIN_EARLY_GRACE_MS;
}

export function isSessionEnded(date, endTime) {
  return Date.now() > slotInstantUTC(date, endTime);
}

// Computes a replacement startTime/endTime (same duration as the original
// slot) anchored to the current IST wall-clock time. Only ever called after
// isBeforeSessionWindow has confirmed `now` is still on the same IST
// calendar day as `date`, so no midnight-rollover handling is needed.
export function shiftedSlotForNow(date, startTime, endTime) {
  const durationMs = slotInstantUTC(date, endTime) - slotInstantUTC(date, startTime);
  const pad = (n) => String(n).padStart(2, '0');
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const newStartTime = `${pad(nowIst.getUTCHours())}:${pad(nowIst.getUTCMinutes())}`;
  const newEndIst = new Date(Date.now() + durationMs + IST_OFFSET_MS);
  const newEndTime = `${pad(newEndIst.getUTCHours())}:${pad(newEndIst.getUTCMinutes())}`;
  return { newStartTime, newEndTime };
}
