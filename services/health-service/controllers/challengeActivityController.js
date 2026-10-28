import { PrismaClient } from '@prisma/client';
import { challengeActivity } from '../services/challengeActivityService.js';
import { hasCoachScopeService } from '../services/coachConsentService.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';

const prisma = new PrismaClient();

export async function getChallengeActivityInternal(req, res) {
  try {
    const userId = Number(req.query.userId);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user' });
    const workout = req.query.metric === 'workout_consistency';
    const enabled = await isFeatureEnabled(workout ? 'workoutTracking' : 'coachJourney');
    // Personal challenges do not widen consent or keep reading after revocation.
    if (!enabled || !await hasCoachScopeService(userId, 'basic')) {
      return res.status(403).json({ error: 'Activity sharing is off for this account' });
    }
    const data = await challengeActivity(prisma, { userId, since: req.query.since,
      metric: req.query.metric, verifiedAttendance: req.query.verifiedAttendance === 'true' });
    return res.json({ data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.error || 'Could not load activity' });
  }
}
