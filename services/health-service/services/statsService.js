import { buildRangeSeriesService } from './exportService.js';
import { startOfIsoWeek } from './goalService.js';

// FR-06 / PRD §08. Everything the Progress screen draws, from one request.
//
// Built on buildRangeSeriesService — the SAME function the CSV/JSON export
// uses — because the BRD's "Robin Hood rule" (Tech §8.3) is that the numbers
// on screen and the numbers in an export of the same range must never
// disagree. Two implementations of "what happened in this range" is how they
// end up disagreeing.
//
// Deliberately computed on read rather than from a materialised DailySummary
// table with a rollup worker, which is what Tech §3.2 sketches. The reason
// is scale, and it's worth writing down so the next person can tell this was
// a decision rather than an oversight: this reads one user's finished
// sessions over at most 12 weeks — roughly a hundred rows behind the
// (userId, localDate) index — and the fleet has no job runner today, so a
// rollup table would mean introducing a scheduler and a staleness window to
// speed up a query that isn't slow. The response shape is exactly what a
// materialised table would serve, so swapping the source later changes this
// file and nothing else.
export const RANGES = { '7d': 7, '30d': 30, '12w': 84 };
export const DEFAULT_RANGE = '30d';

// The heatmap is a 12-week grid whatever the KPI range is: consistency is a
// pattern, and a 7-day heatmap is just a row of squares. One query covers
// both because 12 weeks is the widest window anything here needs.
const HEATMAP_DAYS = 84;

function toLocalDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/// PRD §8.3's stat definitions, in one place so the KPI strip, the bars and
/// the export can't drift on what counts:
///   sessions   = non-rest logs in range
///   minutes    = sum of logged durations
///   volume     = Σ sets × reps × weight (detail-level only; a quick-log with
///                no exercises contributes 0 by design)
///   avg RPE    = mean effort over sessions that recorded one
///   activeDays = distinct days with a non-rest log
export async function getStatsService(userId, requestedRange) {
  const range = RANGES[requestedRange] ? requestedRange : DEFAULT_RANGE;
  const rangeDays = RANGES[range];

  const windowDays = Math.max(rangeDays, HEATMAP_DAYS);
  const windowStart = daysAgo(windowDays - 1);
  const rangeStart = daysAgo(rangeDays - 1);

  const { sessions } = await buildRangeSeriesService(userId, {
    from: toLocalDate(windowStart),
  });

  // A session with no localDate predates that column; fall back to the day
  // its startedAt landed on so old history still appears rather than
  // silently dropping out of every chart.
  const dated = sessions.map((s) => ({
    ...s,
    day: s.localDate || toLocalDate(new Date(s.startedAt)),
  }));

  const rangeStartDay = toLocalDate(rangeStart);
  const inRange = dated.filter((s) => s.day >= rangeStartDay);
  const trained = inRange.filter((s) => s.type !== 'rest');
  const restLogs = inRange.filter((s) => s.type === 'rest');

  const volumeKg = trained.reduce((sum, s) => sum + (s.volumeKg || 0), 0);
  const minutes = trained.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);
  const rpeValues = trained.filter((s) => s.rpe != null).map((s) => s.rpe);
  const activeDays = new Set(trained.map((s) => s.day)).size;

  // ---- G2 weekly bars: ISO weeks, Monday-start, same boundary as the goal
  // and the streak. Empty weeks are emitted rather than skipped, so a gap in
  // training reads as a gap in the chart instead of two bars sitting
  // misleadingly side by side.
  const weekCount = Math.max(4, Math.ceil(rangeDays / 7));
  const weeklyBars = [];
  const thisWeekStart = startOfIsoWeek();
  for (let i = weekCount - 1; i >= 0; i--) {
    const start = new Date(thisWeekStart);
    start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const startDay = toLocalDate(start);
    const endDay = toLocalDate(end);
    const weekSessions = dated.filter(
      (s) => s.type !== 'rest' && s.day >= startDay && s.day <= endDay,
    );
    weeklyBars.push({
      weekStart: startDay,
      sessions: weekSessions.length,
      volumeKg: weekSessions.reduce((sum, s) => sum + (s.volumeKg || 0), 0),
    });
  }

  // ---- G3 consistency heatmap: only days with something logged. The client
  // draws the empty grid; sending 84 zeroes would be most of the payload.
  const heatmapCounts = new Map();
  const heatmapStart = toLocalDate(daysAgo(HEATMAP_DAYS - 1));
  for (const s of dated) {
    if (s.type === 'rest' || s.day < heatmapStart) continue;
    heatmapCounts.set(s.day, (heatmapCounts.get(s.day) || 0) + 1);
  }

  // ---- G6 RPE trend: one point per session that recorded effort, in order.
  const rpeSeries = trained
    .filter((s) => s.rpe != null)
    .map((s) => ({ localDate: s.day, rpe: s.rpe, type: s.type, sessionId: s.sessionId }));

  // ---- G7 split by workout type.
  const typeCounts = new Map();
  for (const s of trained) {
    const key = s.type || 'unspecified';
    typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
  }
  const typeSplit = [...typeCounts.entries()]
    .map(([type, count]) => ({
      type,
      sessions: count,
      percent: trained.length === 0 ? 0 : Math.round((count / trained.length) * 100),
    }))
    .sort((a, b) => b.sessions - a.sessions);

  return {
    range,
    from: rangeStartDay,
    to: toLocalDate(new Date()),
    days: rangeDays,
    kpi: {
      sessions: trained.length,
      minutes,
      volumeKg: Math.round(volumeKg),
      // Null rather than 0 when nothing recorded effort — a zero would read
      // as "you trained at zero effort", which is a different claim.
      avgRpe: rpeValues.length === 0 ? null : Math.round(mean(rpeValues) * 10) / 10,
      restDays: restLogs.length,
      activeDays,
      // Share of days in the range with a non-rest log. Reported as a plain
      // percentage with no target attached — the product's own rule is that
      // charts celebrate consistency rather than score it.
      consistencyPct: rangeDays === 0 ? 0 : Math.round((activeDays / rangeDays) * 100),
    },
    weeklyBars,
    heatmap: [...heatmapCounts.entries()]
      .map(([localDate, sessions]) => ({ localDate, sessions }))
      .sort((a, b) => a.localDate.localeCompare(b.localDate)),
    heatmapStart,
    rpeSeries,
    typeSplit,
  };
}
