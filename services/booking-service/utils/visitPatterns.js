// When does this member actually come? A pure summary of one customer's
// verified visits to one gym, for the partner's member profile. No I/O: the
// caller loads the visits and passes them in, so every rule here is unit-tested
// without a database.
//
// A visit is `{ date, at, kind, checkedOutAt? }`:
//   date          IST calendar date string (YYYY-MM-DD) of the visit
//   at            the instant they were verified in (a Date or ISO string)
//   kind          'booking' (attended a booked session) | 'member' (member check-in)
//   checkedOutAt  when a member checked out, if they did
//
// Everything is read in IST — the gym's local day — never the server's UTC day.

import { clusterSameTimeVisits } from './visitClustering.js';
import { IST_OFFSET_MS, getDayOfWeek } from './slotTiming.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEKS_SHOWN = 8;
const RECENT_SHOWN = 10;
// Below this many visits a "usual time" is a guess, not a pattern.
const MIN_VISITS_FOR_USUAL_TIME = 3;
// The biggest same-time cluster must hold at least this share of visits for the
// member to count as having a usual time.
const MIN_CONSISTENCY_FOR_USUAL_TIME = 0.5;

// Minutes since local (IST) midnight for an instant.
export function minutesOfDayIST(instant) {
  const t = new Date(instant).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((((t + IST_OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY / 60000);
}

function dateToUtcMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToDate(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

// Whole days from `from` to `to` (both YYYY-MM-DD); negative if `to` is earlier.
export function daysBetween(from, to) {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / MS_PER_DAY);
}

// The Monday of the week containing `date`.
export function weekStartOf(date) {
  const weekday = getDayOfWeek(date); // 0 = Sunday
  return utcMsToDate(dateToUtcMs(date) - ((weekday + 6) % 7) * MS_PER_DAY);
}

function timeOfDayBucket(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * @param {Array<{date:string, at:Date|string, kind:'booking'|'member', checkedOutAt?:Date|string|null}>} visits
 * @param {{ today: string, windowDays: number }} options  `today` is the IST date string.
 */
export function summarizeVisitPatterns(visits, { today, windowDays }) {
  const usable = (visits ?? [])
    .map((v) => ({ ...v, minutes: minutesOfDayIST(v.at) }))
    .filter((v) => typeof v.date === 'string' && v.minutes != null && v.date <= today)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const hourly = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const timeOfDay = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const v of usable) {
    const hour = Math.floor(v.minutes / 60);
    hourly[hour] += 1;
    weekdays[getDayOfWeek(v.date)] += 1;
    timeOfDay[timeOfDayBucket(hour)] += 1;
  }

  const days = [...new Set(usable.map((v) => v.date))].sort();
  const daysVisited = days.length;
  const lastVisit = usable[0] ?? null;
  const lastVisitDate = lastVisit ? lastVisit.date : null;
  const firstVisitDate = days[0] ?? null;

  // Distinct days, so two scans on one day are one visit-day.
  const daysInLast = (n) => days.filter((d) => daysBetween(d, today) < n).length;

  // Rate over the stretch they could have visited in: the window, or since their
  // first visit when that is shorter (a member who joined last week is not "low
  // attendance" for the other eleven weeks). At least one week, so a brand-new
  // member is not shown an absurdly high rate.
  const spanDays = firstVisitDate ? Math.min(windowDays, daysBetween(firstVisitDate, today) + 1) : 0;
  const weeksSpanned = Math.max(1, spanDays / 7);
  const avgVisitsPerWeek = daysVisited ? Math.round((daysVisited / weeksSpanned) * 10) / 10 : 0;

  const { mostCommonHour, consistencyRatio } = clusterSameTimeVisits(usable.map((v) => v.minutes));
  const hasUsualTime = usable.length >= MIN_VISITS_FOR_USUAL_TIME && consistencyRatio >= MIN_CONSISTENCY_FOR_USUAL_TIME;
  const peak = Math.max(...hourly);
  const peakHour = usable.length ? hourly.indexOf(peak) : null;

  // Weekdays they favour: the top three, but only days they really repeat on.
  const preferredDays = weekdays
    .map((count, day) => ({ count, day }))
    .filter((d) => d.count >= 2)
    .sort((a, b) => b.count - a.count || a.day - b.day)
    .slice(0, 3)
    .map((d) => d.day);

  // Visit-days per week for the last WEEKS_SHOWN weeks, oldest first, zeros kept
  // so a lapse shows up as a dip rather than disappearing.
  const thisWeek = weekStartOf(today);
  const weekly = [];
  for (let i = WEEKS_SHOWN - 1; i >= 0; i -= 1) {
    const weekStart = utcMsToDate(dateToUtcMs(thisWeek) - i * 7 * MS_PER_DAY);
    weekly.push({ weekStart, visits: days.filter((d) => weekStartOf(d) === weekStart).length });
  }

  const durations = usable
    .filter((v) => v.checkedOutAt)
    .map((v) => (new Date(v.checkedOutAt).getTime() - new Date(v.at).getTime()) / 60000)
    // A check-out is only trustworthy as a duration when it is after the check-in
    // and within a plausible session; otherwise the member just forgot to tap out.
    .filter((m) => Number.isFinite(m) && m > 0 && m <= 6 * 60);
  const avgDurationMinutes = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  return {
    windowDays,
    totalVisits: usable.length,
    daysVisited,
    firstVisitDate,
    lastVisitDate,
    lastVisitAt: lastVisit ? new Date(lastVisit.at).toISOString() : null,
    daysSinceLastVisit: lastVisitDate ? Math.max(0, daysBetween(lastVisitDate, today)) : null,
    visitsLast7Days: daysInLast(7),
    visitsLast30Days: daysInLast(30),
    avgVisitsPerWeek,
    usualHour: hasUsualTime ? mostCommonHour % 24 : null,
    consistency: Math.round(consistencyRatio * 100) / 100,
    peakHour,
    hourly,
    weekdays,
    timeOfDay,
    preferredDays,
    weekly,
    avgDurationMinutes,
    recent: usable.slice(0, RECENT_SHOWN).map((v) => ({ date: v.date, time: hhmm(v.minutes), kind: v.kind })),
  };
}
