// Pure date/expiry rules for corporate-wellness organizations and their
// leaderboards. No I/O, so the rules that decide who can see what (and until
// when) are unit-tested directly.
//
// Days are IST calendar days ('YYYY-MM-DD'), the same convention the rest of
// the platform uses (slotTiming.js, health-service sessionDay.js).

const IST_OFFSET_MS = (5 * 60 + 30) * 60000;
const DAY_MS = 86400000;

export function istDay(value) {
  return new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// The UTC instant an IST calendar day begins.
export function istDayStartUtc(day) {
  return new Date(`${day}T00:00:00+05:30`);
}

// Exclusive upper bound for "everything on or before this IST day".
export function istDayEndExclusiveUtc(day) {
  return new Date(istDayStartUtc(day).getTime() + DAY_MS);
}

// 'active' | 'expired' | 'archived'. `archived` is a manual staff switch;
// `expired` is the profile having reached its expiry and turned into a normal
// one. Computed from the dates so it is right even before the sweep persists it.
export function effectiveOrgStatus(org, now = new Date()) {
  if (org.status === 'archived') return 'archived';
  if (org.expiresAt && new Date(org.expiresAt) <= now) return 'expired';
  if (org.status === 'expired') return 'expired';
  return 'active';
}

// Whole days left until expiry (rounded up), or null when it never expires.
export function daysLeft(org, now = new Date()) {
  if (!org.expiresAt) return null;
  const ms = new Date(org.expiresAt).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

// A leaderboard's real end is the EARLIER of its own end and the company
// profile's expiry — a board cannot outlive the profile it belongs to. When
// neither is set the board is unlimited.
export function leaderboardWindow(board, org, now = new Date()) {
  const ends = [board.endsAt, org?.expiresAt]
    .filter(Boolean)
    .map((d) => new Date(d))
    .sort((a, b) => a - b)[0] ?? null;
  const startsAt = new Date(board.startsAt);
  const finished = ends != null && ends <= now;
  const upcoming = startsAt > now;
  let status = 'live';
  if (board.status === 'archived') status = 'archived';
  else if (finished) status = 'ended';
  else if (upcoming) status = 'upcoming';
  const startDay = istDay(startsAt);
  // Inclusive last day to count: today while live, the last moment before the
  // end once finished.
  const endDay = istDay(finished ? new Date(ends.getTime() - 1) : now);
  return { status, startDay, endDay, endsAt: ends, unlimited: ends == null };
}

export function parseOptionalDate(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw { status: 400, error: `${field} is not a valid date` };
  return d;
}
