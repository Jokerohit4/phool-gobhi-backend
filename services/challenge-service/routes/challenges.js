import { Router } from 'express';
import { requireAuth, requireInternal } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import * as ctrl from '../controllers/challengeController.js';

const router = Router();

// Customer-facing — gated server-side by the streaksCoins flag (not just
// client-hidden), since these expose coin/streak state the admin panel can
// kill independently of a client release.
router.get('/streak/me', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getMyStreak);
router.get('/coins/wallet', requireAuth, requireFeatureFlag('streaksCoins'), ctrl.getMyCoinWallet);

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

export default router;
