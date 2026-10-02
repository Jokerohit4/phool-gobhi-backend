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
 * Evaluates all users with active health ledgers to see if they've
 * maintained a high behavioral score over the last 7 days.
 */
export async function evaluateWeeklyRewards() {
  try {
    // 1. Get all users who have a ledger setup (active participants)
    const users = await prisma.ledgerSetupSate.findMany({
      select: { userId: true },
    });

    const rewardResults = [];

    for (const user of users) {
      const userId = user.userId;
      
      // 2. Calculate average Behavioral Score for the last 7 days
      // We fetch the score series for the last 7 days
      const scores = await prisma.dailyScore.findMany({
        where: {
          userId,
          date: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
        },
        orderBy: { date: 'desc' },
      });

      if (scores.length === 0) continue;

      const avgBehavioral = scores.reduce((sum, s) => sum + s.behavioralScore, 0) / scores.length;

      // 3. Trigger reward if threshold is met
      if (avgBehavioral >= CONSISTENCY_THRESHOLD) {
        try {
          await axios.post(
            `${WALLET_SERVICE_URL}/internal/${userId}/credit`,
            { 
              amount: WEEKLY_REWARD_AMOUNT, 
              description: `Weekly Consistency Reward: Avg score ${avgBehavioral.toFixed(1)}%` 
            },
            await internalHeaders(),
          );
          rewardResults.push({ userId, status: 'rewarded', score: avgBehavioral });
        } catch (err) {
          console.error(`Failed to credit reward for user ${userId}:`, err.message);
          rewardResults.push({ userId, status: 'failed', error: err.message });
        }
      } else {
        rewardResults.push({ userId, status: 'ignored', score: avgBehavioral });
      }
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
