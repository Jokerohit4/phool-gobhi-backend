import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCoachJourney } from '../middleware/requireCoachJourney.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { weekSummary } from '../controllers/weekSummaryController.js';
const router = Router();
router.get('/week-summary', requireAuth, requireCoachJourney, requireFeatureFlag('weeklySummary'), weekSummary);
export default router;
