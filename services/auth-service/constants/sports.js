// The sports a user can say they play (User.sportsPlayed), and the keys the
// sports-venue integration (courts, turfs, centres in gym-service) will tag
// venues with, so "plays tennis" and "a tennis court" are the same word.
//
// Stored as plain strings and validated here rather than as a Postgres enum:
// the catalog grows with the venues we onboard, and adding a value must not
// need an enum migration. Keys are stable slugs; the app owns the labels.
export const SPORTS = [
  'cricket',
  'football',
  'badminton',
  'basketball',
  'tennis',
  'table_tennis',
  'swimming',
  'volleyball',
  'hockey',
  'kabaddi',
  'athletics', // track and field: sprints, jumps, throws
  'running',
  'cycling',
  'other',
];

export const VALID_SPORTS = SPORTS;

/**
 * A sportsPlayed value from a client as a clean list, or null when it is not
 * one: not an array, an unknown key, or a non-string. Duplicates collapse and
 * order is kept. Empty is valid (the user plays none, or skipped).
 */
export function normalizeSportsPlayed(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !VALID_SPORTS.includes(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
