// Attendance + activity score for the per-gym leaderboard.
//
// One 0-100 number per user per window (weekly=7 / monthly=30 / all=90 days),
// blending three ingredients:
//
//   1. Verified presence at THIS gym — AttendanceEventLog rows weighted by
//      how the check-in was proven (the trust ladder, best method per day):
//        member_checkin (partner QR/HMAC scan)  1.00
//        booking (verified booking + geofence)  0.90
//        self_checkin (GPS)                     0.75
//        manual (staff override)                0.50
//      Days are IST calendar days; a user who both scanned the partner QR and
//      had a booking the same day pays the higher trust exactly once. Older
//      days decay (half-life = half the window) so the score describes
//      RECENT consistency — a January chain should not prop up a February
//      leaderboard.
//   2. Daily activity — steps from health-service's DailyActivityMetric,
//      summed over the window and normalized so a ~10k/day pattern maxes it.
//      Weighted at 20 rather than folded into presence because steps are
//      device-reported, not server-verified like attendance.
//   3. Recent-consistency bonus — distinct attended days in the last 7,
//      scaled to 10. A literal consecutive-day streak rarely survives gym
//      cadence (3-4x/week, see challenge-service's UserStreakWeek comment),
//      so "you are on fire THIS week" rewards recentness instead.
//
// Weights and constants are exported for tests and for transparency; they
// are deliberately not admin-tunable yet (same stance the leaderboard took
// with periodic prizes — see getGymLeaderboard's comment).
export const SCORE_WINDOW_DAYS = { weekly: 7, monthly: 30, all: 90 };
export const SCORE_WEIGHTS = { attendance: 70, steps: 20, recent: 10 };
export const SCORE_RECENT_WINDOW_DAYS = 7; // the "streak" window, always last 7 days
export const SCORE_VISITS_PER_WEEK = 4; // expected gym cadence that fills the attendance bucket
export const SCORE_STEPS_DAILY_TARGET = 10000;
// The trust ladder — how well a check-in's presence was proven. An unknown
// source contributes nothing rather than an implicit default.
export const SCORE_TRUST = {
  member_checkin: 1.0,
  booking: 0.9,
  self_checkin: 0.75,
  manual: 0.5,
};
// Match the IST convention everywhere else in the service (slotTiming.js).
const IST_OFFSET_MS = (5 * 60 + 30) * 60000;
const DAY_MS = 86400000;

export function windowDaysFor(window) {
  return SCORE_WINDOW_DAYS[window] ?? SCORE_WINDOW_DAYS.all;
}

function istDayKey(d) {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Whole IST calendar days between two 'YYYY-MM-DD' keys (b-a, signed).
function dayDelta(aKey, bKey) {
  return Math.round((Date.parse(aKey + 'T00:00:00Z') - Date.parse(bKey + 'T00:00:00Z')) / DAY_MS);
}

// Window start as an IST 'YYYY-MM-DD' key and the UTC instant that day begins
// (`attendedAt >= startUtc` is the exact SQL bound for "this IST day onwards").
export function scoreWindow(today, window) {
  const winDays = windowDaysFor(window);
  const startKey = istDayKey(new Date(Date.parse(istDayKey(today) + 'T00:00:00Z') - (winDays - 1) * DAY_MS));
  return { winDays, startKey, startUtc: new Date(Date.parse(startKey + 'T00:00:00Z') - IST_OFFSET_MS) };
}

// Pure score computation over raw feeds. `attendanceEvents` are challenge-
// service AttendanceEventLog rows (gym-scoped by the caller) carrying
// {userId, gymId, attendedAt, source}; `dailyActivityRows` are health-service
// DailyActivityMetric rows carrying {userId, date, steps}; `userIds` is the
// full set to always include, so a never-checked-in challenger scores 0
// rather than vanishing. `today` pins the clock for tests.
export function computeScores({ gymId, attendanceEvents, dailyActivityRows, userIds, window, today = new Date() }) {
  const { winDays, startKey } = scoreWindow(today, window);
  const todayKey = istDayKey(today);
  // ~4 visits/week fills the attendance bucket; weekly=7 -> credit 70/4, the
  // whole window's cadence normalized the same way.
  const expectedVisitCount = Math.max(1, Math.round((winDays / SCORE_RECENT_WINDOW_DAYS) * SCORE_VISITS_PER_WEEK));
  const perDayCredit = SCORE_WEIGHTS.attendance / expectedVisitCount;
  const halfLife = winDays / 2;

  // Best trust per (user, IST day).
  const dayTrustByUser = new Map(); // userId -> Map<dayKey, trust>
  const bestTrustValue = (map, key) => (map.has(key) ? map.get(key) : 0);
  for (const ev of attendanceEvents) {
    if (gymId !== undefined && ev.gymId !== gymId) continue;
    const trust = SCORE_TRUST[ev.source];
    if (trust === undefined) continue;
    const day = istDayKey(new Date(ev.attendedAt));
    const daysAgo = dayDelta(todayKey, day);
    if (daysAgo < 0 || daysAgo >= winDays) continue;
    let byDay = dayTrustByUser.get(ev.userId);
    if (!byDay) {
      byDay = new Map();
      dayTrustByUser.set(ev.userId, byDay);
    }
    if (trust > bestTrustValue(byDay, day)) byDay.set(day, trust);
  }

  // Steps summed over the window per user (null steps count as 0).
  const stepsTotalByUser = new Map();
  for (const row of dailyActivityRows) {
    if (row.date < startKey || row.date > todayKey) continue;
    const steps = Number(row.steps) || 0;
    stepsTotalByUser.set(row.userId, (stepsTotalByUser.get(row.userId) ?? 0) + steps);
  }

  const scores = {};
  for (const userId of userIds) {
    const byDay = dayTrustByUser.get(userId);
    let attendance = 0;
    let recentDays = 0;
    if (byDay) {
      for (const [day, trust] of byDay) {
        const daysAgo = dayDelta(todayKey, day);
        attendance += perDayCredit * trust * Math.pow(0.5, daysAgo / halfLife);
        if (daysAgo < SCORE_RECENT_WINDOW_DAYS) recentDays += 1;
      }
    }
    const attendancePart = Math.min(SCORE_WEIGHTS.attendance, attendance);
    const totalSteps = stepsTotalByUser.get(userId) ?? 0;
    const stepsPart = Math.min(
      SCORE_WEIGHTS.steps,
      SCORE_WEIGHTS.steps * (totalSteps / (SCORE_STEPS_DAILY_TARGET * winDays)),
    );
    const recentPart = Math.min(
      SCORE_WEIGHTS.recent,
      SCORE_WEIGHTS.recent * (recentDays / SCORE_RECENT_WINDOW_DAYS),
    );
    scores[userId] = Math.max(0, Math.min(100, Math.round(attendancePart + stepsPart + recentPart)));
  }
  return scores;
}