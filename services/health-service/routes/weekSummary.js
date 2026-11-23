import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { weekSummary } from '../controllers/weekSummaryController.js';
const router = Router();
router.get('/week-summary', requireAuth, requireFeatureFlag('weeklySummary'), weekSummary);
export default router;
