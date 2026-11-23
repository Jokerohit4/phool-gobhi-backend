import prisma from '../db/prisma.js';
import { challengeActivity } from '../services/challengeActivityService.js';
import { orgActivityForUsers, orgConsentForUsers } from '../services/orgActivityService.js';
import { hasCoachScopeService } from '../services/coachConsentService.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';


export async function getChallengeActivityInternal(req, res) {
  try {
    const userId = Number(req.query.userId);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user' });
    const workout = req.query.metric === 'workout_consistency';
    // coachJourney was retired (always on); only the workout metric still has a flag.
    const enabled = workout ? await isFeatureEnabled('workoutTracking') : true;
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

// Batch per-day activity for company leaderboards (challenge-service). Internal
// only; returns day keys and step counts, never workout contents.
export async function getOrgActivityInternal(req, res) {
  try {
    const ids = [...new Set(String(req.query.ids ?? '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return res.status(400).json({ error: 'ids is required (comma-separated user ids)' });
    if (ids.length > 500) return res.status(400).json({ error: 'ids must contain at most 500 user ids' });
    const data = await orgActivityForUsers(prisma, { userIds: ids, from: req.query.from, to: req.query.to });
    return res.json({ data });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.error : 'Could not load activity' });
  }
}

// Lightweight "has this person agreed?" check for the company card, so the app
// can ask for consent without pulling any activity.
export async function getOrgConsentInternal(req, res) {
  try {
    const ids = [...new Set(String(req.query.ids ?? '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return res.status(400).json({ error: 'ids is required (comma-separated user ids)' });
    if (ids.length > 500) return res.status(400).json({ error: 'ids must contain at most 500 user ids' });
    return res.json({ data: await orgConsentForUsers(prisma, ids) });
  } catch (error) {
    return res.status(500).json({ error: 'Could not load consent' });
  }
}
