// "Today" for admin analytics: everything since midnight IST, the same timezone
// the Traffic report buckets its days in. The warehouse windows are written as
// "now minus N days", so Today is expressed as a fractional N (hours elapsed
// since IST midnight / 24). Both the PostgreSQL interval cast and the BigQuery
// adapter accept fractional days.
const IST_OFFSET_MS = 330 * 60000;
const DAY_MS = 86400000;
// Just after midnight the elapsed time is ~0; keep a small floor so the window
// is never empty or zero-length.
const MIN_DAYS = 1 / 48;

export const TODAY = 'today';

export function isToday(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === TODAY;
}

export function todayWindowDays(now = new Date()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const startOfIstDay = Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return Math.max((ms - startOfIstDay) / DAY_MS, MIN_DAYS);
}
