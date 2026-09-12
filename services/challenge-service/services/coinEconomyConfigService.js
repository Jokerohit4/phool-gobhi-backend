import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Placeholder numbers from the planning docs (explicitly flagged "guess"
// there too) — shipped as the default so the feature isn't empty on day
// one, but fully admin-editable via PUT /admin/coins/economy-config with no
// redeploy required. See the 2026-08-21 decision in the gamification plan.
export const DEFAULT_ECONOMY_CONFIG = {
  coinsPerCheckin: 10,
  weeklyTargetBonus: 20,
  milestones: { '2': 50, '4': 150, '12': 500 },
  pairedStreakWeeklyBonus: 15,
  qualifyingCheckinsPerWeek: 2,
  // Health & Activity gamified layer (see health-service's implementation
  // plan) — paid once per finished WorkoutSession that coincides with a
  // verified AttendanceEventLog the same day. Deliberately higher than a
  // bare check-in: logging a full structured session is more signal than
  // just showing up.
  coinsPerVerifiedWorkout: 15,
  // Gym trials (D-05/D-06, docs/../sprint2/PG-HUNT-001). Real money — the
  // founder personally pays each gym its own session rate per redemption —
  // so this is a monthly spending decision, not a coin number: 10/month at
  // typical Rs 300-600 trials is ~Rs 3,000-6,000/month, recurring. Shared
  // across every gym_trial catalog item (all tiers combined), not per item —
  // see coinCatalogService.redeemCatalogItemByUserService.
  gymTrialMonthlyCap: 10,
  // One trial per user, EVER — also shared across tiers, so a single
  // enthusiast can't claim the neighbourhood, mid-tier AND premium trial in
  // one month. 1, not a boolean, so it's editable from the same admin
  // surface as every other coin figure without a schema change.
  gymTrialPerUserLimit: 1,
};

const MAX_COIN_AMOUNT = 100_000; // sanity ceiling, mirrors wallet-service's HARD_MAX_TOPUP_AMOUNT convention
// A week has 7 days — more than 7 qualifying check-ins in one week is not a
// meaningful requirement, so this doubles as the sane upper bound.
const MAX_QUALIFYING_CHECKINS_PER_WEEK = 7;
// These are unit counts, not coin amounts, so MAX_COIN_AMOUNT is the wrong
// ceiling for them — 1000 gym trials in a month would already be a
// different business than the one this cap was designed for, and a
// per-user limit above 10 stops meaningfully limiting anything.
const MAX_GYM_TRIAL_MONTHLY_CAP = 1_000;
const MAX_GYM_TRIAL_PER_USER_LIMIT = 10;

function validateBoundedInt(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw { status: 400, error: `${label} must be a whole number between ${min} and ${max}` };
  }
  return n;
}

export async function loadEconomyConfig() {
  const row = await prisma.coinEconomyConfig.findUnique({ where: { id: 1 } });
  if (!row) return { ...DEFAULT_ECONOMY_CONFIG, updatedAt: null };
  return {
    coinsPerCheckin: row.coinsPerCheckin,
    weeklyTargetBonus: row.weeklyTargetBonus,
    milestones: row.milestones,
    pairedStreakWeeklyBonus: row.pairedStreakWeeklyBonus,
    qualifyingCheckinsPerWeek: row.qualifyingCheckinsPerWeek,
    coinsPerVerifiedWorkout: row.coinsPerVerifiedWorkout,
    gymTrialMonthlyCap: row.gymTrialMonthlyCap,
    gymTrialPerUserLimit: row.gymTrialPerUserLimit,
    updatedAt: row.updatedAt,
  };
}

function validateAmount(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COIN_AMOUNT) {
    throw { status: 400, error: `${label} must be a whole number between 0 and ${MAX_COIN_AMOUNT}` };
  }
  return n;
}

export async function updateEconomyConfig(
  {
    coinsPerCheckin,
    weeklyTargetBonus,
    milestones,
    pairedStreakWeeklyBonus,
    qualifyingCheckinsPerWeek,
    coinsPerVerifiedWorkout,
    gymTrialMonthlyCap,
    gymTrialPerUserLimit,
  },
  updatedBy
) {
  const coinsPerCheckinValue = validateAmount(coinsPerCheckin, 'coinsPerCheckin');
  const weeklyTargetBonusValue = validateAmount(weeklyTargetBonus, 'weeklyTargetBonus');
  const pairedStreakWeeklyBonusValue = validateAmount(pairedStreakWeeklyBonus, 'pairedStreakWeeklyBonus');
  const coinsPerVerifiedWorkoutValue = validateAmount(coinsPerVerifiedWorkout, 'coinsPerVerifiedWorkout');
  const qualifyingCheckinsPerWeekValue = Number(qualifyingCheckinsPerWeek);
  if (!Number.isInteger(qualifyingCheckinsPerWeekValue) || qualifyingCheckinsPerWeekValue < 1 || qualifyingCheckinsPerWeekValue > MAX_QUALIFYING_CHECKINS_PER_WEEK) {
    throw { status: 400, error: `qualifyingCheckinsPerWeek must be a whole number between 1 and ${MAX_QUALIFYING_CHECKINS_PER_WEEK}` };
  }
  // A cap of 0 is deliberately allowed (min 0, not 1) — it's the honest way
  // to switch gym trials off entirely (e.g. the founder pausing the budget
  // for a month) without deactivating every gym_trial catalog item one by
  // one. A per-user limit of 0 would be nonsensical (nobody could ever
  // redeem one), so that floor stays at 1.
  const gymTrialMonthlyCapValue = validateBoundedInt(gymTrialMonthlyCap, 'gymTrialMonthlyCap', 0, MAX_GYM_TRIAL_MONTHLY_CAP);
  const gymTrialPerUserLimitValue = validateBoundedInt(gymTrialPerUserLimit, 'gymTrialPerUserLimit', 1, MAX_GYM_TRIAL_PER_USER_LIMIT);
  if (typeof milestones !== 'object' || milestones === null || Array.isArray(milestones)) {
    throw { status: 400, error: 'milestones must be an object mapping week-number strings to coin amounts' };
  }
  const cleanMilestones = {};
  for (const [week, amount] of Object.entries(milestones)) {
    const weekNum = Number(week);
    if (!Number.isInteger(weekNum) || weekNum <= 0) {
      throw { status: 400, error: `milestone key "${week}" must be a positive whole number of weeks` };
    }
    cleanMilestones[String(weekNum)] = validateAmount(amount, `milestone amount for week ${week}`);
  }
  const data = {
    coinsPerCheckin: coinsPerCheckinValue,
    weeklyTargetBonus: weeklyTargetBonusValue,
    milestones: cleanMilestones,
    pairedStreakWeeklyBonus: pairedStreakWeeklyBonusValue,
    qualifyingCheckinsPerWeek: qualifyingCheckinsPerWeekValue,
    coinsPerVerifiedWorkout: coinsPerVerifiedWorkoutValue,
    gymTrialMonthlyCap: gymTrialMonthlyCapValue,
    gymTrialPerUserLimit: gymTrialPerUserLimitValue,
    updatedBy,
  };
  const updated = await prisma.coinEconomyConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });
  return {
    coinsPerCheckin: updated.coinsPerCheckin,
    weeklyTargetBonus: updated.weeklyTargetBonus,
    milestones: updated.milestones,
    pairedStreakWeeklyBonus: updated.pairedStreakWeeklyBonus,
    qualifyingCheckinsPerWeek: updated.qualifyingCheckinsPerWeek,
    coinsPerVerifiedWorkout: updated.coinsPerVerifiedWorkout,
    gymTrialMonthlyCap: updated.gymTrialMonthlyCap,
    gymTrialPerUserLimit: updated.gymTrialPerUserLimit,
    updatedAt: updated.updatedAt,
  };
}
