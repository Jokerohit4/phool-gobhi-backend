import { Router } from 'express';
import { requireRole, requireInternal } from '../middleware/requireAuth.js';
import * as ctrl from '../controllers/bookingController.js';
import * as analyticsCtrl from '../controllers/analyticsController.js';

const router = Router();

// Internal service-to-service endpoint (gym-service calls this to compute slot availability)
router.get('/internal/slot-counts/:gymId', requireInternal, ctrl.getSlotCounts);
// Internal (gym-service calls this to compute class-occurrence availability)
router.get('/internal/class-counts/:classId', requireInternal, ctrl.getClassCounts);
// Internal (gym-service's deleteGymAdmin — refuses to hard-delete a gym with booking history)
router.get('/internal/gym/:gymId/booking-count', requireInternal, ctrl.getBookingCountForGym);
// Internal (wallet-service's closeOutSubscriptionIfLapsed — gift-day/attendance-bonus close-out)
router.get('/internal/bookings/subscription/:id/completed-count', requireInternal, ctrl.getCompletedVisitCountForSubscription);
// Internal (wallet-service's getMySubscriptionsService — mid-period gift-box teaser)
router.get('/internal/bookings/subscription/:id/last-visit-date', requireInternal, ctrl.getLastVisitDateForSubscription);
// Internal (auth-service's attendance-SaaS re-engagement sweep — bulk "has this
// customer ever completed a booking" check, batched to avoid N sequential calls)
router.post('/internal/bookings/has-completed-batch', requireInternal, ctrl.getCustomerIdsWithCompletedBooking);

// Public, unauthenticated — marketing-site aggregate stat only. Must be
// paired with a gateway PUBLIC_ROUTES entry (see index.js).
router.get('/public/attendance-stats', ctrl.getPublicAttendanceStats);

router.post('/', requireRole('customer'), ctrl.createBooking);
router.get('/mine', requireRole('customer'), ctrl.getMyBookings);
router.get('/mine/attendance-summary', requireRole('customer'), ctrl.getMyAttendanceSummary);
router.get('/mine/attendance-warnings', requireRole('customer'), ctrl.getMyAttendanceWarnings);
// Gamification wave 1: lifetime per-gym visit rollup for the badge shelf / fog-of-war map.
router.get('/mine/visited-gyms', requireRole('customer'), ctrl.getVisitedGyms);
// gobhi too — the admin portal's /settings page reads this to prefill its editor.
router.get('/cancellation-policy', requireRole('customer', 'gobhi'), ctrl.getCancellationPolicy);
router.put('/cancellation-policy', requireRole('gobhi'), ctrl.updateCancellationPolicy);
router.get('/gym/:gymId', requireRole('partner'), ctrl.getGymBookings);
router.get('/gym/:gymId/summary', requireRole('partner'), ctrl.getGymSalesSummary);
router.get('/gym/:gymId/attendance-summary', requireRole('partner'), ctrl.getGymAttendanceSummary);
// Partner-facing "Gym insights" — the gym-scoped slice of analytics_events
// (funnel/revenue-trend/retention) that closes the gap-analysis finding that
// the wedge's own analytics never reached the partner. See analyticsController.js.
router.get('/gym/:gymId/analytics', requireRole('partner'), analyticsCtrl.getGymAnalyticsForPartner);
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
router.get('/admin/analytics/known-events', requireRole('gobhi'), analyticsCtrl.getKnownEvents);
router.get('/admin/analytics/known-properties', requireRole('gobhi'), analyticsCtrl.getKnownPropertyKeys);
router.get('/admin/analytics/known-values', requireRole('gobhi'), analyticsCtrl.getKnownPropertyValues);
router.get('/admin/analytics/anon-sessions', requireRole('gobhi'), analyticsCtrl.getRecentAnonSessions);
router.get('/admin/analytics/event-search', requireRole('gobhi'), analyticsCtrl.searchEventUsers);
router.get('/admin/analytics/custom-funnel', requireRole('gobhi'), analyticsCtrl.getCustomFunnelResult);
router.get('/admin/analytics/funnels', requireRole('gobhi'), analyticsCtrl.listSavedFunnels);
router.post('/admin/analytics/funnels', requireRole('gobhi'), analyticsCtrl.createSavedFunnel);
router.delete('/admin/analytics/funnels/:id', requireRole('gobhi'), analyticsCtrl.deleteSavedFunnel);
router.get('/admin/analytics/user-journey', requireRole('gobhi'), analyticsCtrl.getUserJourney);
router.get('/admin/analytics/city-breakdown', requireRole('gobhi'), analyticsCtrl.getCityBreakdown);
// Gamification wave 1: per-gym badge_earned counts, a supply-density signal.
router.get('/admin/analytics/badges-summary', requireRole('gobhi'), analyticsCtrl.getBadgeSummary);
router.get('/admin/analytics/revenue-trend', requireRole('gobhi'), analyticsCtrl.getRevenueTrend);
router.get('/admin/analytics/supply-health', requireRole('gobhi'), analyticsCtrl.getSupplyHealth);
router.get('/admin/analytics/retention', requireRole('gobhi'), analyticsCtrl.getRetentionCohorts);
router.get('/admin/analytics/website-traffic', requireRole('gobhi'), analyticsCtrl.getWebsiteTraffic);
router.get('/admin/analytics/location-reach', requireRole('gobhi'), analyticsCtrl.getLocationReach);
router.put('/:id/cancel', requireRole('customer'), ctrl.cancelBooking);
router.post('/:id/request-checkin', requireRole('customer'), ctrl.requestCheckIn);
router.put('/:id/confirm', requireRole('partner'), ctrl.confirmBooking);
router.post('/:id/verify-attendance', requireRole('partner'), ctrl.verifyAttendance);
router.post('/gym/:gymId/self-checkin', requireRole('customer'), ctrl.selfCheckIn);
router.put('/:id/complete', requireRole('partner'), ctrl.completeBooking);

export default router;
