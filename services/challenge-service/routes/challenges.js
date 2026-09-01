import { Router } from 'express';
import { requireAuth, requireInternal, requireRole } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import * as ctrl from '../controllers/challengeController.js';

const router = Router();

// Customer-facing — gated server-side by the relevant flag (not just
// client-hidden), since these expose coin/streak/challenge state the admin
// panel can kill independently of a client release.
router.get('/streak/me', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getMyStreak);
router.get('/coins/wallet', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getMyCoinWallet);
router.get('/coins/catalog', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getCoinCatalog);
router.get('/', requireAuth, requireFeatureFlag('challenges'), ctrl.getChallenges);
router.get('/:id', requireAuth, requireFeatureFlag('challenges'), ctrl.getChallengeDetail);
router.post('/:id/enroll', requireAuth, requireFeatureFlag('challenges'), ctrl.enrollInChallenge);
router.post('/:id/leave', requireAuth, requireFeatureFlag('challenges'), ctrl.leaveChallenge);
router.post('/:id/checkpoint', requireAuth, requireFeatureFlag('challenges'), ctrl.visitCheckpoint);
router.post('/paired-streaks/opt-in', requireAuth, requireFeatureFlag('buddyPairedStreaks'), ctrl.optInPairedStreak);
router.get('/paired-streaks/me', requireAuth, requireFeatureFlag('buddyPairedStreaks'), ctrl.getMyPairedStreaks);

// Admin (gobhi) — same role-gate convention as gym-service's /:id/approve,
// wallet-service's /payouts, etc. Not flag-gated: an admin must always be
// able to configure/inspect these even while turned off for customers, e.g.
// to set up the pilot challenges before flipping the flag on for the first time.
router.get('/admin/coins/economy-config', requireRole('gobhi'), ctrl.getCoinEconomyConfigAdmin);
router.put('/admin/coins/economy-config', requireRole('gobhi'), ctrl.updateCoinEconomyConfigAdmin);
router.get('/admin/coins/catalog', requireRole('gobhi'), ctrl.listCoinCatalogAdmin);
router.post('/admin/coins/catalog', requireRole('gobhi'), ctrl.createCoinCatalogItemAdmin);
router.put('/admin/coins/catalog/:id', requireRole('gobhi'), ctrl.updateCoinCatalogItemAdmin);

router.get('/admin/challenges/definitions', requireRole('gobhi'), ctrl.listChallengeDefinitionsAdmin);
router.post('/admin/challenges/definitions', requireRole('gobhi'), ctrl.createChallengeDefinitionAdmin);
router.get('/admin/challenges', requireRole('gobhi'), ctrl.listChallengesAdmin);
router.post('/admin/challenges', requireRole('gobhi'), ctrl.createChallengeAdmin);
router.put('/admin/challenges/:id', requireRole('gobhi'), ctrl.updateChallengeAdmin);
router.get('/admin/challenges/:id/checkpoint-spots', requireRole('gobhi'), ctrl.listCheckpointSpotsAdmin);
router.post('/admin/challenges/:id/checkpoint-spots', requireRole('gobhi'), ctrl.createCheckpointSpotAdmin);
router.get('/admin/challenges/:id/enrollments', requireRole('gobhi'), ctrl.listEnrollmentsAdmin);
router.get('/admin/sponsors', requireRole('gobhi'), ctrl.listSponsorsAdmin);
router.post('/admin/sponsors', requireRole('gobhi'), ctrl.createSponsorAdmin);

// Internal — booking-service fires attendance events on every verified
// check-in, driving both streak/coin recording and off-peak-challenge
// progress off the same signal. Each concern checks its own flag inside the
// handler (see recordAttendanceEventInternal) rather than gating the whole
// route, since one attendance event can be relevant to either flag
// independently. A cron fires the weekly streak close; other backend
// services call the coin credit/debit pair for redemption/reward flows.
router.post('/internal/attendance-events', requireInternal, ctrl.recordAttendanceEventInternal);
router.post('/internal/streak/close-week', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.closeWeekInternal);
router.post('/internal/coins/:userId/credit', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.creditCoinsInternal);
router.post('/internal/coins/:userId/debit', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.debitCoinsInternal);

// Health & Activity gamified layer — health-service calls this once when a
// WorkoutSession finishes (see its implementation plan's "Gamified layer"
// section). Flag-gated like every other coin route: a harmless no-op until
// streaksCoins is turned on.
router.post('/internal/workout-credit', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.creditWorkoutInternal);

// Subscription-discount redemption (wallet-service calls these at purchase
// time — see wallet-service's purchaseSubscriptionWithWallet).
router.post('/internal/coins/redemptions', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.redeemCoinCatalogItemInternal);
// Deliberately NOT flag-gated — see the handler's own comment.
router.post('/internal/coins/redemptions/:redemptionId/refund', requireInternal, ctrl.refundCoinRedemptionInternal);

export default router;
