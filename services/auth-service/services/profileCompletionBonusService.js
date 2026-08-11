import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Default ₹ bonus credited once when a profile crosses from incomplete to
// complete — applied until an admin explicitly saves a row via PUT
// /api/auth/profile-completion-bonus/admin. Same "no row yet" convention as
// loadOtpProvider/loadLaunchGate. 0 disables the bonus entirely.
export const DEFAULT_PROFILE_COMPLETION_BONUS = 20;

// Redeploy-only ceiling the admin UI can never raise above, mirroring
// wallet-service's HARD_MAX_TOPUP_AMOUNT convention.
export const MAX_PROFILE_COMPLETION_BONUS = 1000;

export async function loadProfileCompletionBonusAmount() {
  const row = await prisma.profileCompletionBonusSetting.findUnique({ where: { id: 1 } });
  return row?.amount ?? DEFAULT_PROFILE_COMPLETION_BONUS;
}

export async function loadProfileCompletionBonusAdmin() {
  const row = await prisma.profileCompletionBonusSetting.findUnique({ where: { id: 1 } });
  return {
    amount: row?.amount ?? DEFAULT_PROFILE_COMPLETION_BONUS,
    updatedAt: row?.updatedAt || null,
  };
}

export async function updateProfileCompletionBonusAmount(amount, updatedBy) {
  const value = Number(amount);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PROFILE_COMPLETION_BONUS) {
    throw {
      status: 400,
      error: `amount must be a whole number between 0 and ${MAX_PROFILE_COMPLETION_BONUS} (0 disables the bonus)`,
    };
  }
  return prisma.profileCompletionBonusSetting.upsert({
    where: { id: 1 },
    create: { id: 1, amount: value, updatedBy },
    update: { amount: value, updatedBy },
  });
}
