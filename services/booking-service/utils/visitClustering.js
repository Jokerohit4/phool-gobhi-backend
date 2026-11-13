// Pure helper (unit-tested): group minute-of-day visit times into "same
// time" clusters by greedy nearest-center join and report how dominant the
// biggest cluster is. mostCommonHour is that cluster's mean time of day
// rounded to the nearest hour (6:52 -> 7) — the hour shown on the partner
// app's "Routine 7 AM" badge.
//
// Lives in its own module (bookingService re-exports it) so the member visit
// patterns can reuse it without importing the whole booking service.

// A visit joins an existing "same time" cluster when its minute-of-day lands
// within this tolerance of the cluster's running-mean center. 30m keeps a
// realistic gym-going timeslot together (6:45/7:00/7:30) while still
// separating genuinely different habits (7:00 vs 13:00).
export const MEMBER_ACTIVITY_TIME_TOLERANCE_MINUTES = 30;

export function clusterSameTimeVisits(times, tolerance = MEMBER_ACTIVITY_TIME_TOLERANCE_MINUTES) {
  if (!times || times.length === 0) return { mostCommonHour: 0, consistencyRatio: 0 };
  const clusters = [];
  for (const t of times) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < clusters.length; i += 1) {
      const d = Math.abs(clusters[i].center - t);
      if (d <= tolerance && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const c = clusters[bestIdx];
      c.sum += t;
      c.count += 1;
      c.center = Math.round(c.sum / c.count);
    } else {
      clusters.push({ sum: t, count: 1, center: t });
    }
  }
  const largest = clusters.reduce((best, c) => (c.count > best.count ? c : best), clusters[0]);
  return {
    mostCommonHour: Math.round(largest.center / 60),
    consistencyRatio: largest.count / times.length,
  };
}
