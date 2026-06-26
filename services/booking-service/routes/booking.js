import { Router } from 'express';
import { requireRole, requireInternal } from '../middleware/requireAuth.js';
import * as ctrl from '../controllers/bookingController.js';

const router = Router();

// Internal service-to-service endpoint (gym-service calls this to compute slot availability)
router.get('/internal/slot-counts/:gymId', requireInternal, ctrl.getSlotCounts);

router.post('/', requireRole('customer'), ctrl.createBooking);
router.get('/mine', requireRole('customer'), ctrl.getMyBookings);
router.get('/gym/:gymId', requireRole('partner'), ctrl.getGymBookings);
router.get('/gym/:gymId/summary', requireRole('partner'), ctrl.getGymSalesSummary);
router.put('/:id/cancel', requireRole('customer'), ctrl.cancelBooking);
router.post('/:id/request-checkin', requireRole('customer'), ctrl.requestCheckIn);
router.put('/:id/complete', requireRole('partner'), ctrl.completeBooking);

export default router;
