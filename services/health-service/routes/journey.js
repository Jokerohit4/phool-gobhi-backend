import { Router } from 'express';
import { requireAuth, requireInternal } from '../middleware/requireAuth.js';
import { requireCoachJourney } from '../middleware/requireCoachJourney.js';
import { requireCoachConsent } from '../middleware/requireCoachConsent.js';
import { anyOf } from '../middleware/anyOf.js';
import { requireAdult } from '../middleware/requireAdult.js';
import * as journeyCtrl from '../controllers/journeyController.js';

const router = Router();

const coachGated = [requireAuth, requireCoachJourney, requireCoachConsent('basic')];

// POST /journey/start - Start a new journey (idempotent, updates if re-run)
router.post('/journey/start', ...coachGated, requireAdult, journeyCtrl.startJourneyController);

// GET /journey - Get current journey progress
router.get('/journey', ...coachGated, journeyCtrl.getJourneyController);

// POST /journey/food-early - Unlock food layer early
router.post('/journey/food-early', ...coachGated, journeyCtrl.unlockFoodEarlyController);

// POST /journey/accept-refresh - Accept a plan refresh proposal
router.post('/journey/accept-refresh', ...coachGated, journeyCtrl.acceptRefreshController);

// POST /journey/body - Save body data (height, weight) and rebuild plan
router.post('/journey/body', ...coachGated, journeyCtrl.journeyBodyController);

// POST /journey/diet - Save diet preference and rebuild plan
router.post('/journey/diet', ...coachGated, journeyCtrl.journeyDietController);

// GET /journey/summary - Get journey summary for Home screen
router.get('/journey/summary', ...coachGated, journeyCtrl.journeySummaryController);

export default router;