// IST-anchored Monday-start week boundary — the one the streak weeks, the
// paired-streak weeks and (in health-service) the home ring and the training
// stats all key on.
//
// India observes no DST, so a fixed +05:30 offset is exact, and the boundary
// has to be IST rather than UTC: a check-in at 00:00–05:29 IST Monday is
// still Sunday in UTC, and under a UTC boundary it fell into the previous
// week — a user training early Monday saw last week's streak. Anchoring on
// IST means "this week" matches the user's calendar everywhere.
//
// This must stay behaviourally identical to health-service's
// utils/sessionDay.js startOfIsoWeek, which the home-track streak and goal
// ring use. The services are separate deployables with no shared package, so
// the copy is duplicated the same way utils/analytics.js is.
export const IST_OFFSET_MS = (5 * 60 + 30) * 60000;

export function startOfIsoWeek(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const day = (ist.getUTCDay() + 6) % 7; // 0 = Monday
  ist.setUTCDate(ist.getUTCDate() - day);
  ist.setUTCHours(0, 0, 0, 0);
  return ist;
}
