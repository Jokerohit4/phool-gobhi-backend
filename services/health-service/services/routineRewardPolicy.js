import { isoDayIST } from '../utils/sessionDay.js';
// Small, deterministic activity rewards. Dates are server-owned IST days.
export const ROUTINE_REWARD_LAUNCH = new Date('2026-10-26T00:00:00+05:30');
export const istDay = (date = new Date()) => isoDayIST(date);
export function routineRewardPolicy(createdAt, now = new Date()) {
  const age = Math.floor((Date.parse(istDay(now)) - Date.parse(istDay(createdAt))) / 86400000);
  const eligible = Number.isFinite(age) && age >= 0 && new Date(createdAt) >= ROUTINE_REWARD_LAUNCH;
  return {
    eligible, day: age + 1,
    waterLog: eligible && age < 7 ? 1 : 0,
    waterLogDailyCap: eligible && age < 7 ? 3 : 0,
    waterTarget: eligible && age < 14 ? 1 : 0,
    workout: eligible ? (age < 7 ? 2 : age < 14 ? 1 : 0) : 0,
    locationWorkout: eligible ? (age < 7 ? 4 : 3) : 0,
    waterIntervalMinutes: 60,
  };
}
