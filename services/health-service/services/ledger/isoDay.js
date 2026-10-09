/**
 * A real calendar day in 'YYYY-MM-DD'.
 *
 * Not a regex alone. `/^\d{4}-\d{2}-\d{2}$/` happily accepts '2026-13-45',
 * which Date.UTC then silently rolls forward into a valid date in the next
 * year - so a pause written from garbage input would land on a real day in the
 * wrong month, and report itself as active. The round-trip check is what makes
 * "is this a day" mean a day the user could actually be living through.
 *
 * Shared rather than owned by one service. The controller needs the same
 * notion of valid, the score service re-exports it, and the nutrition service
 * validates the localDate a saved-meal repeat writes with it - a repeat with an
 * empty date used to write rows no day query could ever match. Two definitions
 * of a valid date in one feature is how the boundary ends up accepting what the
 * writer rejects.
 */
export function isIsoDay(value) {
  const s = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
