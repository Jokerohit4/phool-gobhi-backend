import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { getGoalPlan, previewGoalPlan, putGoalPlan, putGoalPlanTask } from '../controllers/coachPlanController.js';

const router = Router();
router.get('/plan/goal', requireAuth, getGoalPlan);
router.post('/plan/goal/preview', requireAuth, previewGoalPlan);
router.put('/plan/goal', requireAuth, putGoalPlan);
router.put('/plan/goal/task', requireAuth, putGoalPlanTask);
export default router;
