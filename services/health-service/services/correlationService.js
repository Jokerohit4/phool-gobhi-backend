import { PrismaClient } from '@prisma/client';
import { BIOLOGICAL_TARGETS } from './ledger/constants.js';

const prisma = new PrismaClient();

/**
 * Correlates biological marker improvements with AI-prescribed behavioral changes.
 * 
 * Logic:
 * 1. Find a "turning point" in the biomarker trajectory where the value began moving toward the ideal range.
 * 2. Look for AI-prescribed plan items or templates created/started shortly before that turning point.
 * 3. If a strong correlation exists, return an insight.
 */
export async function correlateMarkerImprovement(userId, marker) {
  const target = BIOLOGICAL_TARGETS[marker.toLowerCase()];
  if (!target) return null;

  // 1. Fetch trajectory (last 180 days for better trend analysis)
  // No `verified` filter: BiometricEntry has no such column, so filtering on it
  // threw "Unknown argument 'verified'". Rows are confirmed by construction.
  const entries = await prisma.biometricEntry.findMany({
    where: {
      userId,
      metric: marker,
      createdAt: { gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (entries.length < 2) return null;

  // 2. Identify turning point (where the slope changed in the right direction)
  let turningPointDate = null;
  let improvementMagnitude = 0;
  const firstValue = Number(entries[0].value);
  const lastValue = Number(entries[entries.length - 1].value);

  // Check if there was an overall improvement
  const improved = target.idealMax !== undefined 
    ? lastValue < firstValue 
    : lastValue > firstValue;

  if (!improved) return null;

  improvementMagnitude = Math.abs(lastValue - firstValue);

  // Find the date where the most significant shift occurred
  for (let i = 1; i < entries.length; i++) {
    const prev = Number(entries[i - 1].value);
    const curr = Number(entries[i].value);
    const delta = target.idealMax !== undefined ? prev - curr : curr - prev;
    
    if (delta > 0) {
      turningPointDate = entries[i].createdAt;
      break; // First significant move toward ideal
    }
  }

  if (!turningPointDate) return null;

  // 3. Look for AI-prescribed plans started 0-30 days before the turning point
  const windowStart = new Date(turningPointDate);
  windowStart.setDate(windowStart.getDate() - 30);

  const aiPlans = await prisma.planItem.findMany({
    where: {
      userId,
      fromPrescription: true,
      createdAt: {
        gte: windowStart,
        lte: turningPointDate,
      },
    },
  });

  if (aiPlans.length === 0) return null;

  // Return the most prominent plan as the correlate
  const primaryPlan = aiPlans[0];

  return {
    marker,
    improvement: improvementMagnitude,
    direction: target.idealMax !== undefined ? 'decrease' : 'increase',
    correlatedPlan: primaryPlan.title,
    insight: `Your ${marker} improved by ${improvementMagnitude.toFixed(1)} after you started the "${primaryPlan.title}" AI plan.`,
    confidence: aiPlans.length > 1 ? 'high' : 'medium',
  };
}
