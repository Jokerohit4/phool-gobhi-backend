import { PrismaClient } from '@prisma/client';
import { behavioralAverages, todayIST, shiftDay, CONSISTENCY_WINDOW_DAYS } from './ledger/scoreService.js';
import { creditWeeklyConsistencyCoins } from '../utils/notifyChallengeService.js';

const prisma = new PrismaClient();

// The bar the Health Score card draws and the amount it promises. Both are
// shown to the user verbatim, so changing either here changes a promise.
export const CONSISTENCY_THRESHOLD = 80; // 7-day behavioural average, 0-100
export const WEEKLY_REWARD_COINS = 50;

/**
 * Monday of the IST week containing `localDate`, as 'YYYY-MM-DD' - the
 * once-per-week key for the bonus. Evaluation runs on every nightly close, so
 * without a weekly key a user above the bar would be paid every night.
 */
export function weekStartIST(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return shiftDay(localDate, -((weekday + 6) % 7));
}

/**
 * Pays the weekly consistency bonus if the user's 7-day behavioural average
 * (scoreService.behavioralAverages - the same figure the card's bar shows) is
 * at or above the threshold. Triggered by each nightly day close.
 *
 * Never throws: a failure here must not affect closing the user's day.
 */
export async function evaluateUserReward(userId, { today = todayIST() } = {}) {
  try {
    const averages = await behavioralAverages(prisma, { userIds: [userId], today });
    const average = averages.get(userId);
    if (average === undefined) return { userId, status: 'ignored', reason: 'no scores' };
    if (average < CONSISTENCY_THRESHOLD) return { userId, status: 'ignored', score: average };

    const weekStart = weekStartIST(today);
    const paid = await creditWeeklyConsistencyCoins({
      userId, weekStart, amount: WEEKLY_REWARD_COINS, average,
    });
    return paid
      ? { userId, status: 'rewarded', score: average, weekStart }
      : { userId, status: 'failed', score: average, error: 'coin credit failed' };
  } catch (err) {
    console.error(`Failed to evaluate reward for user ${userId}:`, err.message);
    return { userId, status: 'failed', error: err.message };
  }
}

/**
 * Platform-wide sweep, for a manual trigger. Evaluates everyone with a closed
 * day in the window - the only users who can have an average at all. (This
 * used to read a `ledgerSetupSate` model that does not exist, so it threw on
 * every call.) Safe to re-run: the weekly idempotency key makes a repeat pay
 * nobody twice.
 */
export async function evaluateWeeklyRewards({ today = todayIST() } = {}) {
  const users = await prisma.scoreDaySnapshot.findMany({
    where: { localDate: { gte: shiftDay(today, -CONSISTENCY_WINDOW_DAYS), lt: today } },
    select: { userId: true },
    distinct: ['userId'],
  });

  const results = [];
  for (const { userId } of users) {
    results.push(await evaluateUserReward(userId, { today }));
  }

  return {
    totalProcessed: users.length,
    rewardedCount: results.filter((r) => r.status === 'rewarded').length,
    results,
  };
}
