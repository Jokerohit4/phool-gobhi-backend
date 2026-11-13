import { creditCoinsService } from './coinLedgerService.js';

// Onboarding's reward ladder, paid in coins. The app used to show "Next: ₹10"
// chips and celebrate locally while nothing was ever credited anywhere. The
// amounts live here, not in the request: the client names the step it just
// finished and the server decides what that is worth. Keyed per user and step,
// so replaying, retrying or re-onboarding pays each step once - at most 20
// coins an account, which is also the ceiling on what a forged claim can get.
export const ONBOARDING_COIN_REWARDS = Object.freeze({
  details: 10,
  health_basics: 5,
  medical_docs: 5,
});

export async function claimOnboardingRewardService(userId, step) {
  const amount = ONBOARDING_COIN_REWARDS[step];
  if (!amount) throw { status: 400, error: 'Unknown onboarding step' };
  const balance = await creditCoinsService(
    userId, amount, `Onboarding reward: ${step}`, `onboarding:${userId}:${step}`,
  );
  return { step, amount, balance };
}
