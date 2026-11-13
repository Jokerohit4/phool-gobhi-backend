import { Router } from 'express';
import { planGated, planSoftGated } from '../middleware/requirePlan.js';
import * as coachPlanCtrl from '../controllers/coachPlanController.js';

// The one-plan surface (one-plan Contracts · API). Every mutation returns the
// fresh today payload; the two reads soft-gate so a user without coach basic
// consent gets 200 no_plan rather than an error. Mounted next to journeyRouter
// in routes/health.js — the paths here are the full /plan/... paths.
const router = Router();

router.get('/plan/today', ...planSoftGated, coachPlanCtrl.getToday);
router.get('/plan', ...planSoftGated, coachPlanCtrl.getPlan);

router.post('/plan/items/:id/complete', ...planGated, coachPlanCtrl.completeItem);
router.delete('/plan/items/:id/complete', ...planGated, coachPlanCtrl.uncompleteItem);
router.post('/plan/items', ...planGated, coachPlanCtrl.createItem);
router.delete('/plan/items/:id', ...planGated, coachPlanCtrl.deleteItem);
router.post('/plan/settings/preview', ...planGated, coachPlanCtrl.previewSettings);
router.put('/plan/settings', ...planGated, coachPlanCtrl.saveSettings);
router.put('/plan/slots', ...planGated, coachPlanCtrl.saveSlots);
router.post('/plan/layers/food/early', ...planGated, coachPlanCtrl.foodEarly);

export default router;
