import { PrismaClient } from '@prisma/client';
import {
  getJourney,
  startJourney,
  startWellnessJourney,
  switchJourneyTrack,
  getJourneySummary,
  getUnlockedLayerKeys,
  getScoringWindow,
} from '../services/journey/journeyService.js';
import { hasCoachScopeService } from '../services/coachConsentService.js';

const prisma = new PrismaClient();

export async function getJourneyController(req, res) {
  try {
    const journey = await getJourney(req.userId);
    if (!journey) {
      return res.status(404).json({
        error: 'Journey not started. Call POST /journey/start to begin.',
        code: 'JOURNEY_NOT_STARTED',
      });
    }
    return res.json({ data: journey });
  } catch (err) {
    console.error('[journey] GET /journey error:', err);
    return res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
}

export async function startWellnessJourneyController(req, res) {
  try {
    const hasConsent = await hasCoachScopeService(req.userId, 'basic');
    if (!hasConsent) return res.status(403).json({ error: 'Coach consent required', code: 'CONSENT_REQUIRED' });
    const result = await startWellnessJourney(req.userId);
    return res.json({ data: result });
  } catch (err) {
    console.error('[journey] POST /journey/wellness/start error:', err);
    return res.status(err.status || 500).json({ error: err.error || err.message || 'Server error', code: err.code });
  }
}

export async function startJourneyController(req, res) {
  try {
    const { experienceLevel, goals, daysPerWeek, location, quitReason } = req.body || {};

    if (!experienceLevel || !['new_to_gym', 'just_started', 'restarting_after_break', 'experienced'].includes(experienceLevel)) {
      return res.status(400).json({ error: 'experienceLevel must be one of: new_to_gym, just_started, restarting_after_break, experienced', code: 'INVALID_EXPERIENCE_LEVEL' });
    }
    if (!Array.isArray(goals)) {
      return res.status(400).json({ error: 'goals must be an array', code: 'INVALID_GOALS' });
    }
    const dpw = Number(daysPerWeek);
    if (!Number.isInteger(dpw) || dpw < 1 || dpw > 7) {
      return res.status(400).json({ error: 'daysPerWeek must be an integer between 1 and 7', code: 'INVALID_DAYS_PER_WEEK' });
    }
    if (!location || !['gym', 'home', 'fitness_centre', 'sports', 'other'].includes(location)) {
      return res.status(400).json({ error: 'location must be one of: gym, home, fitness_centre, sports, other', code: 'INVALID_LOCATION' });
    }
    if (quitReason && !['time', 'boredom', 'no_results', 'injury', 'alone'].includes(quitReason)) {
      return res.status(400).json({ error: 'quitReason must be one of: time, boredom, no_results, injury, alone', code: 'INVALID_QUIT_REASON' });
    }

    // Check coach consent (basic scope required)
    const hasConsent = await hasCoachScopeService(req.userId, 'basic');
    if (!hasConsent) {
      return res.status(403).json({ error: 'Coach consent required', code: 'CONSENT_REQUIRED' });
    }

    const result = await startJourney(req.userId, { experienceLevel, goals, daysPerWeek: dpw, location, quitReason });
    return res.json({ data: result });
  } catch (err) {
    console.error('[journey] POST /journey/start error:', err);
    return res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
}




export async function journeySummaryController(req, res) {
  try {
    const summary = await getJourneySummary(req.userId);
    return res.json({ data: summary });
  } catch (err) {
    console.error('[journey] GET /journey/summary error:', err);
    return res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
}

// Export the service functions for other services (B7, B10)
export { getUnlockedLayerKeys, getScoringWindow };

// auth-service's persona-switch fan-out (services/personaEvents.js there).
// Only a journey that already exists is touched; see switchJourneyTrack.
export async function personaChangedInternalController(req, res) {
  try {
    const userId = Number(req.body?.userId);
    const toPersona = req.body?.toPersona;
    if (!Number.isInteger(userId) || userId <= 0 || typeof toPersona !== 'string') {
      return res.status(400).json({ error: 'userId and toPersona required' });
    }
    const result = await switchJourneyTrack(userId, toPersona);
    return res.json({ data: result });
  } catch (err) {
    console.error('[journey] POST /internal/journey/persona-changed error:', err);
    return res.status(err.status || 500).json({ error: err.error || err.message || 'Server error', code: err.code });
  }
}
