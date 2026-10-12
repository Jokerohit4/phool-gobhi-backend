import { PrismaClient } from '@prisma/client';
import {
  getJourney,
  startJourney,
  unlockFoodEarly,
  acceptRefresh,
  getJourneySummary,
  getUnlockedLayerKeys,
  getScoringWindow,
} from '../services/journey/journeyService.js';
import { saveDiet } from '../services/ledger/bodyDataService.js';
import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';
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

export async function startJourneyController(req, res) {
  try {
    const { experienceLevel, goals, daysPerWeek, location, quitReason } = req.body || {};

    if (!experienceLevel || !['new_to_gym', 'restarting_after_break', 'experienced'].includes(experienceLevel)) {
      return res.status(400).json({ error: 'experienceLevel must be one of: new_to_gym, restarting_after_break, experienced', code: 'INVALID_EXPERIENCE_LEVEL' });
    }
    if (!Array.isArray(goals)) {
      return res.status(400).json({ error: 'goals must be an array', code: 'INVALID_GOALS' });
    }
    const dpw = Number(daysPerWeek);
    if (!Number.isInteger(dpw) || dpw < 1 || dpw > 7) {
      return res.status(400).json({ error: 'daysPerWeek must be an integer between 1 and 7', code: 'INVALID_DAYS_PER_WEEK' });
    }
    if (!location || !['gym', 'home'].includes(location)) {
      return res.status(400).json({ error: 'location must be "gym" or "home"', code: 'INVALID_LOCATION' });
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

export async function unlockFoodEarlyController(req, res) {
  try {
    const journey = await unlockFoodEarly(req.userId);
    return res.json({ data: journey });
  } catch (err) {
    console.error('[journey] POST /journey/food-early error:', err);
    return res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
}

export async function acceptRefreshController(req, res) {
  try {
    const result = await acceptRefresh(req.userId);
    return res.json({ data: result });
  } catch (err) {
    console.error('[journey] POST /journey/accept-refresh error:', err);
    return res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
}

export async function journeyBodyController(req, res) {
  try {
    const { heightCm, weightKg } = req.body || {};
    if (heightCm == null || weightKg == null) {
      return res.status(400).json({ error: 'heightCm and weightKg are required', code: 'MISSING_BODY_DATA' });
    }

    // Get sex and date of birth from internal profile
    const profile = await fetchUserProfileInternal(req.userId);
    const sex = profile?.gender; // 'male' | 'female' | 'other'
    const dateOfBirth = profile?.dateOfBirth; // ISO string

    const { bodyDataService } = await import('../ledger/bodyDataService.js');
    await bodyDataService.save(prisma, req.userId, { heightCm: Number(heightCm), weightKg: Number(weightKg), sex, dateOfBirth });

    // Return the updated plan
    const { prescriptionService } = await import('../ledger/prescriptionService.js');
    const journeyContext = { unlockedLayerKeys: await getUnlockedLayerKeys(req.userId) };
    const plan = await prescriptionService.getPlan({ prisma, userId: req.userId, journey: journeyContext });

    return res.json({ data: { plan } });
  } catch (err) {
    console.error('[journey] POST /journey/body error:', err);
    return res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
}

export async function journeyDietController(req, res) {
  try {
    const { diet } = req.body || {};
    const validDiets = ['veg', 'egg', 'non_veg', 'vegan', 'jain'];
    if (!diet || !validDiets.includes(diet)) {
      return res.status(400).json({ error: `diet must be one of: ${validDiets.join(', ')}`, code: 'INVALID_DIET' });
    }

    await saveDiet(prisma, req.userId, diet);

    // Return the updated plan
    const { prescriptionService } = await import('../ledger/prescriptionService.js');
    const journeyContext = { unlockedLayerKeys: await getUnlockedLayerKeys(req.userId) };
    const plan = await prescriptionService.getPlan({ prisma, userId: req.userId, journey: journeyContext });

    return res.json({ data: { plan } });
  } catch (err) {
    console.error('[journey] POST /journey/diet error:', err);
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