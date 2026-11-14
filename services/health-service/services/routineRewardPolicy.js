import { isoDayIST } from '../utils/sessionDay.js';
// Small, deterministic activity rewards. Dates are server-owned IST days.
export const ROUTINE_REWARD_LAUNCH = new Date('2026-10-26T00:00:00+05:30');
export const istDay = (date = new Date()) => isoDayIST(date);
// Product rule (2026-11-14): any coin grant that is paid at all pays at least
// this many coins - 1-coin grants read as too small to notice. A reward that is
// switched off stays 0; only paid amounts are lifted. Keep in step with the
// upper bound in challenge-service's workoutCreditService routine-policy check.
export const MIN_COIN_GRANT = 5;
const paid = (amount) => (amount > 0 ? Math.max(MIN_COIN_GRANT, amount) : 0);
export function routineRewardPolicy(createdAt, now = new Date()) {
  const age = Math.floor((Date.parse(istDay(now)) - Date.parse(istDay(createdAt))) / 86400000);
  const eligible = Number.isFinite(age) && age >= 0 && new Date(createdAt) >= ROUTINE_REWARD_LAUNCH;
  const workout = paid(eligible ? (age < 7 ? 2 : age < 14 ? 1 : 0) : 0);
  return {
    eligible, day: age + 1,
    waterLog: paid(eligible && age < 7 ? 1 : 0),
    waterLogDailyCap: eligible && age < 7 ? 3 : 0,
    waterTarget: paid(eligible && age < 14 ? 1 : 0),
    // One grant per IST day for the first two weeks, same window as the water
    // target: a saved sleep/body number and a saved mood check-in.
    sleepLog: paid(eligible && age < 14 ? 1 : 0),
    moodLog: paid(eligible && age < 14 ? 1 : 0),
    workout,
    // Total for a location-verified workout. The location part is paid as its
    // own grant (total - workout), so it must itself clear the minimum.
    locationWorkout: eligible ? workout + MIN_COIN_GRANT : 0,
    waterIntervalMinutes: 60,
  };
}
