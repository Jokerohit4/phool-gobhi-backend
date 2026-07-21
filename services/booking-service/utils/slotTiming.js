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
