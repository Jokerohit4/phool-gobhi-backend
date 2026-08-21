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
};

const MAX_COIN_AMOUNT = 100_000; // sanity ceiling, mirrors wallet-service's HARD_MAX_TOPUP_AMOUNT convention

export async function loadEconomyConfig() {
  const row = await prisma.coinEconomyConfig.findUnique({ where: { id: 1 } });
  if (!row) return { ...DEFAULT_ECONOMY_CONFIG, updatedAt: null };
  return {
    coinsPerCheckin: row.coinsPerCheckin,
    weeklyTargetBonus: row.weeklyTargetBonus,
    milestones: row.milestones,
    pairedStreakWeeklyBonus: row.pairedStreakWeeklyBonus,
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

export async function updateEconomyConfig({ coinsPerCheckin, weeklyTargetBonus, milestones, pairedStreakWeeklyBonus }, updatedBy) {
  const coinsPerCheckinValue = validateAmount(coinsPerCheckin, 'coinsPerCheckin');
  const weeklyTargetBonusValue = validateAmount(weeklyTargetBonus, 'weeklyTargetBonus');
  const pairedStreakWeeklyBonusValue = validateAmount(pairedStreakWeeklyBonus, 'pairedStreakWeeklyBonus');
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
    updatedAt: updated.updatedAt,
  };
}
