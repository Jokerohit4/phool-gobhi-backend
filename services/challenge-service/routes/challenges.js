import { Router } from 'express';
import { requireAuth, requireInternal, requireRole } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import * as ctrl from '../controllers/challengeController.js';

const router = Router();

// Customer-facing — gated server-side by the streaksCoins flag (not just
// client-hidden), since these expose coin/streak state the admin panel can
// kill independently of a client release.
router.get('/streak/me', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getMyStreak);
router.get('/coins/wallet', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getMyCoinWallet);
router.get('/coins/catalog', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getCoinCatalog);

// Admin (gobhi) — same role-gate convention as gym-service's /:id/approve,
// wallet-service's /payouts, etc. Not flag-gated: an admin must always be
// able to configure/inspect the economy even while it's turned off for
// customers, e.g. to set it up before flipping the flag on for the first time.
router.get('/admin/coins/economy-config', requireRole('gobhi'), ctrl.getCoinEconomyConfigAdmin);
router.put('/admin/coins/economy-config', requireRole('gobhi'), ctrl.updateCoinEconomyConfigAdmin);
router.get('/admin/coins/catalog', requireRole('gobhi'), ctrl.listCoinCatalogAdmin);
router.post('/admin/coins/catalog', requireRole('gobhi'), ctrl.createCoinCatalogItemAdmin);
router.put('/admin/coins/catalog/:id', requireRole('gobhi'), ctrl.updateCoinCatalogItemAdmin);

// Internal — booking-service fires attendance events on every verified
// check-in; a cron fires the weekly close; other backend services will call
// the coin credit/debit pair once redemption/reward flows exist (Phase 2+).
// Also flag-gated: booking-service's fire-and-forget call is a harmless
// no-op (403, swallowed) until streaksCoins is turned on — this is what
// makes Phase 0's wiring inert until Phase 2 flips the switch, and what
// keeps "no streak backfill from before cutover" true by construction rather
// than by a separate backfill-avoidance rule.
router.post('/internal/attendance-events', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.recordAttendanceEventInternal);
router.post('/internal/streak/close-week', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.closeWeekInternal);
router.post('/internal/coins/:userId/credit', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.creditCoinsInternal);
router.post('/internal/coins/:userId/debit', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.debitCoinsInternal);

// Subscription-discount redemption (wallet-service calls these at purchase
// time — see wallet-service's purchaseSubscriptionWithWallet).
router.post('/internal/coins/redemptions', requireInternal, requireFeatureFlag('streaksCoins'), ctrl.redeemCoinCatalogItemInternal);
// Deliberately NOT flag-gated — see the handler's own comment.
router.post('/internal/coins/redemptions/:redemptionId/refund', requireInternal, ctrl.refundCoinRedemptionInternal);

export default router;
