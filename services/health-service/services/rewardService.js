import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { computeBlendedHealthScore } from './scoreEngine.js';

const prisma = new PrismaClient();
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Reward configuration
const CONSISTENCY_THRESHOLD = 80; // Average Behavioral Score required for reward
const WEEKLY_REWARD_AMOUNT = 50;   // Coins granted for meeting threshold

async function internalHeaders() {
  return { headers: { 'x-internal-key': INTERNAL_API_KEY } };
}

/**
 * Evaluates a single user to see if they've maintained a high behavioral score 
 * over the last 7 days. Triggered by Day Close events.
 */
export async function evaluateUserReward(userId) {
  try {
    // Calculate average Behavioral Score for the last 7 days
    const scores = await prisma.dailyScore.findMany({
      where: {
        userId,
        date: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        },
      },
      orderBy: { date: 'desc' },
    });

    if (scores.length === 0) return { userId, status: 'ignored', reason: 'no scores' };

    const avgBehavioral = scores.reduce((sum, s) => sum + s.behavioralScore, 0) / scores.length;

    if (avgBehavioral >= CONSISTENCY_THRESHOLD) {
      await axios.post(
        `${WALLET_SERVICE_URL}/internal/${userId}/credit`,
        { 
          amount: WEEKLY_REWARD_AMOUNT, 
          description: `Weekly Consistency Reward: Avg score ${avgBehavioral.toFixed(1)}%` 
        },
        await internalHeaders(),
      );
      return { userId, status: 'rewarded', score: avgBehavioral };
    }

    return { userId, status: 'ignored', score: avgBehavioral };
  } catch (err) {
    console.error(`Failed to evaluate reward for user ${userId}:`, err.message);
    return { userId, status: 'failed', error: err.message };
  }
}

/**
 * Global sweep for legacy support or manual triggers.
 * Now delegates to evaluateUserReward.
 */
export async function evaluateWeeklyRewards() {
  try {
    const users = await prisma.ledgerSetupSate.findMany({
      select: { userId: true },
    });

    const rewardResults = [];
    for (const user of users) {
      const res = await evaluateUserReward(user.userId);
      rewardResults.push(res);
    }

    return {
      totalProcessed: users.length,
      rewardedCount: rewardResults.filter(r => r.status === 'rewarded').length,
      results: rewardResults,
    };
  } catch (err) {
    console.error('evaluateWeeklyRewards failed:', err);
    throw err;
  }
}
