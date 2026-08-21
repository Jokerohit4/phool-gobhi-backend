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
// Live occupancy ("who's here right now") + attendance heatmap ("which day,
// what time") — partner (own gym, ownership-checked) and admin (any/all
// gyms) versions. See bookingService.js's fetchLiveOccupancy/
// computeAttendanceHeatmap for why `started` status / attendedAt is the
// signal used.
router.get('/gym/:gymId/live', requireRole('partner'), ctrl.getGymLiveOccupancy);
router.get('/gym/:gymId/attendance-heatmap', requireRole('partner'), ctrl.getGymAttendanceHeatmap);
// Per-member activity — most/least active, time spent, same-time vs varies.
// One dataset, sorted/sliced into several views client-side (see
// bookingService.js's computeMemberActivity for why).
router.get('/gym/:gymId/member-activity', requireRole('partner'), ctrl.getMemberActivityForGym);
router.get('/admin/gym/:gymId/member-activity', requireRole('gobhi'), ctrl.getMemberActivityAdmin);
router.get('/admin/attendance-summary', requireRole('gobhi'), ctrl.getAdminAttendanceSummary);
router.get('/admin/attendance-summary/by-gym', requireRole('gobhi'), ctrl.getAdminAttendanceByGym);
// Admin-only: bookings/presence explorer for one gym (previously admin had
// NO bookings list at all, unlike partner-web's own /bookings).
router.get('/admin/gym/:gymId/bookings', requireRole('gobhi'), ctrl.getGymBookingsAdmin);
router.get('/admin/live', requireRole('gobhi'), ctrl.getAdminLiveOccupancy);
router.get('/admin/attendance-heatmap', requireRole('gobhi'), ctrl.getAdminAttendanceHeatmap);
// Admin-only: top-performing-gyms leaderboard — the mirror image of the
// existing supply-health view (which finds the worst gyms).
router.get('/admin/top-gyms', requireRole('gobhi'), ctrl.getTopPerformingGyms);

// Trainer self-service (role='trainer', see auth-service's new trainer
// account type) — their own check-in + logging which attended customer
// booking they trained.
router.post('/gym/:gymId/trainer-checkin', requireRole('trainer'), ctrl.trainerCheckIn);
router.get('/gym/:gymId/trainer-attendance/mine', requireRole('trainer'), ctrl.getMyTrainerAttendance);
router.get('/gym/:gymId/trainer-sessions/today', requireRole('trainer'), ctrl.getTodaysTrainableBookings);
router.post('/gym/:gymId/trainer-sessions', requireRole('trainer'), ctrl.logTrainingSession);
router.get('/gym/:gymId/trainer-sessions/mine', requireRole('trainer'), ctrl.getMyTrainingSessions);
// Partner/admin dashboard: per-trainer attendance + who they've trained.
router.get('/gym/:gymId/trainers-overview', requireRole('partner'), ctrl.getTrainersOverviewForGym);
router.get('/admin/gym/:gymId/trainers-overview', requireRole('gobhi'), ctrl.getTrainersOverviewAdmin);

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
