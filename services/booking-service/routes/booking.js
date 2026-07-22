import { Router } from 'express';
import { requireRole, requireInternal } from '../middleware/requireAuth.js';
import * as ctrl from '../controllers/bookingController.js';

const router = Router();

// Internal service-to-service endpoint (gym-service calls this to compute slot availability)
router.get('/internal/slot-counts/:gymId', requireInternal, ctrl.getSlotCounts);

// Public, unauthenticated — marketing-site aggregate stat only. Must be
// paired with a gateway PUBLIC_ROUTES entry (see index.js).
router.get('/public/attendance-stats', ctrl.getPublicAttendanceStats);

router.post('/', requireRole('customer'), ctrl.createBooking);
router.get('/mine', requireRole('customer'), ctrl.getMyBookings);
router.get('/mine/attendance-summary', requireRole('customer'), ctrl.getMyAttendanceSummary);
router.get('/cancellation-policy', requireRole('customer'), ctrl.getCancellationPolicy);
router.put('/cancellation-policy', requireRole('gobhi'), ctrl.updateCancellationPolicy);
router.get('/gym/:gymId', requireRole('partner'), ctrl.getGymBookings);
router.get('/gym/:gymId/summary', requireRole('partner'), ctrl.getGymSalesSummary);
router.get('/gym/:gymId/attendance-summary', requireRole('partner'), ctrl.getGymAttendanceSummary);
router.get('/admin/attendance-summary', requireRole('gobhi'), ctrl.getAdminAttendanceSummary);
router.get('/admin/attendance-summary/by-gym', requireRole('gobhi'), ctrl.getAdminAttendanceByGym);
router.put('/:id/cancel', requireRole('customer'), ctrl.cancelBooking);
router.post('/:id/request-checkin', requireRole('customer'), ctrl.requestCheckIn);
router.post('/:id/verify-attendance', requireRole('partner'), ctrl.verifyAttendance);
router.post('/gym/:gymId/self-checkin', requireRole('customer'), ctrl.selfCheckIn);
router.put('/:id/complete', requireRole('partner'), ctrl.completeBooking);

export default router;
