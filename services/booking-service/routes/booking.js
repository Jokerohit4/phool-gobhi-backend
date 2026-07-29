import { Router } from 'express';
import { requireRole, requireInternal } from '../middleware/requireAuth.js';
import * as ctrl from '../controllers/bookingController.js';
import * as analyticsCtrl from '../controllers/analyticsController.js';

const router = Router();

// Internal service-to-service endpoint (gym-service calls this to compute slot availability)
router.get('/internal/slot-counts/:gymId', requireInternal, ctrl.getSlotCounts);

// Public, unauthenticated — marketing-site aggregate stat only. Must be
// paired with a gateway PUBLIC_ROUTES entry (see index.js).
router.get('/public/attendance-stats', ctrl.getPublicAttendanceStats);

router.post('/', requireRole('customer'), ctrl.createBooking);
router.get('/mine', requireRole('customer'), ctrl.getMyBookings);
router.get('/mine/attendance-summary', requireRole('customer'), ctrl.getMyAttendanceSummary);
router.get('/mine/attendance-warnings', requireRole('customer'), ctrl.getMyAttendanceWarnings);
router.get('/cancellation-policy', requireRole('customer'), ctrl.getCancellationPolicy);
router.put('/cancellation-policy', requireRole('gobhi'), ctrl.updateCancellationPolicy);
router.get('/gym/:gymId', requireRole('partner'), ctrl.getGymBookings);
router.get('/gym/:gymId/summary', requireRole('partner'), ctrl.getGymSalesSummary);
router.get('/gym/:gymId/attendance-summary', requireRole('partner'), ctrl.getGymAttendanceSummary);
router.get('/admin/attendance-summary', requireRole('gobhi'), ctrl.getAdminAttendanceSummary);
router.get('/admin/attendance-summary/by-gym', requireRole('gobhi'), ctrl.getAdminAttendanceByGym);

// Admin analytics dashboards (phool-gobhi-admin's /analytics page) — reads
// from analytics_events via a separate pool (see analyticsQueryService.js),
// not this service's own Prisma-backed operational DB.
router.get('/admin/analytics/onboarding-funnel', requireRole('gobhi'), analyticsCtrl.getOnboardingFunnel);
router.get('/admin/analytics/approval-sla', requireRole('gobhi'), analyticsCtrl.getApprovalSla);
router.get('/admin/analytics/conversion-funnel', requireRole('gobhi'), analyticsCtrl.getConversionFunnel);
router.get('/admin/analytics/fulfillment-funnel', requireRole('gobhi'), analyticsCtrl.getFulfillmentFunnel);
router.get('/admin/analytics/activation', requireRole('gobhi'), analyticsCtrl.getActivation);
router.get('/admin/analytics/wallet-funnel', requireRole('gobhi'), analyticsCtrl.getWalletFunnel);
router.get('/admin/analytics/buddy-funnel', requireRole('gobhi'), analyticsCtrl.getBuddyFunnel);
router.get('/admin/analytics/trend', requireRole('gobhi'), analyticsCtrl.getTrend);
router.get('/admin/analytics/user-journey', requireRole('gobhi'), analyticsCtrl.getUserJourney);
router.get('/admin/analytics/city-breakdown', requireRole('gobhi'), analyticsCtrl.getCityBreakdown);
router.get('/admin/analytics/revenue-trend', requireRole('gobhi'), analyticsCtrl.getRevenueTrend);
router.get('/admin/analytics/supply-health', requireRole('gobhi'), analyticsCtrl.getSupplyHealth);
router.put('/:id/cancel', requireRole('customer'), ctrl.cancelBooking);
router.post('/:id/request-checkin', requireRole('customer'), ctrl.requestCheckIn);
router.put('/:id/confirm', requireRole('partner'), ctrl.confirmBooking);
router.post('/:id/verify-attendance', requireRole('partner'), ctrl.verifyAttendance);
router.post('/gym/:gymId/self-checkin', requireRole('customer'), ctrl.selfCheckIn);
router.put('/:id/complete', requireRole('partner'), ctrl.completeBooking);

export default router;
