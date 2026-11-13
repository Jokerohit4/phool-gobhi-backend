import { computeBlendedHealthScore } from './scoreEngine.js';
import { USE_CLOSED_DAY_BEHAVIORAL_AVERAGE } from './constants.js';

export function behavioralAverageForSnapshots(snapshots, { useClosedDays = USE_CLOSED_DAY_BEHAVIORAL_AVERAGE } = {}) {
  const closedDays = snapshots.length;
  const sum = snapshots.reduce((n, s) => n + computeBlendedHealthScore(Number(s.close), null), 0);
  const avgScore = useClosedDays && closedDays < 4 ? null
    : Math.round(sum / (useClosedDays ? closedDays : 7) * 10) / 10;
  return { avgScore, closedDays };
}
