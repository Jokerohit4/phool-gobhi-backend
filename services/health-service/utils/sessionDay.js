// Single source of truth for the two things every session/day surface must
// agree on, so a check-in, a workout and a streak can never land on different
// days or count different sessions (audit 2026-10-08, P2 row 49):
//
//   1. WHAT DAY it is — the IST calendar day (the platform's only launched
//      market). Everything is keyed on a 'YYYY-MM-DD' string.
//   2. WHAT COUNTS as a workout session — finished, not a rest log, and at
//      least one completed set. An empty quick-log (finish with zero sets)
//      and a rest day are excluded from every count, everywhere.
//
// A "day" is represented as a UTC-midnight Date whose UTC date-part IS the
// IST calendar day, so the existing `toISOString().slice(0, 10)` day math
// keeps working unchanged while the boundary moves to IST.
//
// The offset is fixed to Asia/Kolkata because that is the platform's only
// launched market; the BRD's travelling-user edge case makes this a per-user
// lookup later, not a hardcoded offset forever. When it does, it changes
// here and nowhere else.
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The IST calendar day ('YYYY-MM-DD') of an instant.
export function istDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// A 'YYYY-MM-DD' back to the UTC-midnight Date that represents that day.
export function dayToDate(day) {
  return new Date(`${day}T00:00:00Z`);
}

// The 'YYYY-MM-DD' of a day-Date (UTC date-part, which is the IST day).
export function dayString(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// The UTC-midnight Date of the IST Monday of the week containing `date`.
// IST-anchored (not UTC) so a check-in at 00:00–05:29 IST Monday lands in the
// week it belongs to, matching what the user's calendar says.
export function startOfIsoWeek(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const day = (ist.getUTCDay() + 6) % 7; // 0 = Monday
  ist.setUTCDate(ist.getUTCDate() - day);
  ist.setUTCHours(0, 0, 0, 0);
  return ist;
}

// The Prisma `where` fragment for "this session counts". Spread it into a
// workoutSession query whose other clauses (userId, day range) are the
// caller's. Kept as a fragment rather than a helper so every count is done
// by the database, not by fetching rows and filtering in JS.
export const COUNTED_WORKOUT_WHERE = Object.freeze({
  endedAt: { not: null },
  NOT: { type: 'rest' },
  exercises: { some: { sets: { some: { completed: true } } } },
});

// The JS-side twin, for rows that already carry `completedSets` (the export
// builder's shape). Returns true only for a finished, non-rest session with
// at least one completed set.
export function countsAsSession(session) {
  if (!session || session.endedAt == null || session.type === 'rest') return false;
  if (typeof session.completedSets === 'number') return session.completedSets > 0;
  return true;
}
