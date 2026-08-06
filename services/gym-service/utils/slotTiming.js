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

// Weekday (0=Sunday..6=Saturday) of a plain IST calendar-date string —
// timezone-invariant, since it only depends on the calendar date itself, not
// the instant it represents (India has no DST).
export function getDayOfWeek(date) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

// Today's date as an IST calendar-date string — same IST anchor used
// elsewhere (see gymController.js's getGymAvailability), factored out so any
// date-less caller resolves "today" consistently.
export function todayDateStringIST() {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()))
    .toISOString().split('T')[0];
}
