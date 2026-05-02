import { Router } from 'express';
import { requireRole } from '../middleware/requireAuth.js';
import * as ctrl from '../controllers/bookingController.js';

const router = Router();

router.post('/', requireRole('customer'), ctrl.createBooking);
router.get('/mine', requireRole('customer'), ctrl.getMyBookings);
router.get('/gym/:gymId', requireRole('partner'), ctrl.getGymBookings);
router.get('/gym/:gymId/summary', requireRole('partner'), ctrl.getGymSalesSummary);
router.put('/:id/cancel', requireRole('customer'), ctrl.cancelBooking);
router.put('/:id/complete', requireRole('partner'), ctrl.completeBooking);

export default router;
