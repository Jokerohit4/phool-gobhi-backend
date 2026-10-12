import { Router } from 'express';
import { requireInternal, requireRole } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { uploadBuddyPhotos, MAX_BUDDY_PHOTOS } from '../utils/upload.js';
import * as ctrl from '../controllers/buddyController.js';

const router = Router();

// Every client-facing buddy route requires auth — matchmaking/chat should
// never be reachable anonymously. None of these are added to the gateway's
// PUBLIC_ROUTES.
//
// Three gate classes (build plan, Buddy safety → API):
//   - customer routes: requireRole('customer') + the buddy flag (403
//     FEATURE_DISABLED when off — not 404, which the app reads as "no profile");
//   - admin moderation routes: requireRole('gobhi') and NO flag check, so
//     moderation keeps working while buddy is off;
//   - /internal/*: neither (requireInternal only).
// requireRole runs first so a partner gets 403 Forbidden whatever the flag.
const customer = [requireRole('customer'), requireFeatureFlag('buddy')];
const gobhi = requireRole('gobhi');

router.get('/profile/me', ...customer, ctrl.getMyProfile);
router.post('/profile', ...customer, ctrl.upsertProfile);
router.put('/profile', ...customer, ctrl.upsertProfile);
router.post('/profile/refresh', ...customer, ctrl.refreshProfile);

router.post('/photos', ...customer, uploadBuddyPhotos.array('photos', MAX_BUDDY_PHOTOS), ctrl.addPhotos);
router.post('/photos/from-url', ...customer, ctrl.addPhotoFromUrl);
router.put('/photos/order', ...customer, ctrl.reorderPhotos);
router.delete('/photos/:photoId', ...customer, ctrl.deletePhoto);

router.get('/filters', ...customer, ctrl.getFilters);
router.put('/filters', ...customer, ctrl.updateFilters);

router.get('/discover', ...customer, ctrl.getDiscoveryFeed);
router.post('/swipes', ...customer, ctrl.swipe);

router.get('/matches', ...customer, ctrl.getMatches);
router.get('/matches/:matchId/profile', ...customer, ctrl.getMatchedProfile);
router.post('/matches/:matchId/unmatch', ...customer, ctrl.unmatch);
router.get('/matches/:matchId/messages', ...customer, ctrl.getMessages);
router.post('/matches/:matchId/messages', ...customer, ctrl.sendMessage);

router.post('/blocks', ...customer, ctrl.blockUser);
router.delete('/blocks/:userId', ...customer, ctrl.unblockUser);
router.get('/blocks', ...customer, ctrl.listBlocked);

// Reports. Filing one is a customer route; triaging is gobhi-only (the gateway
// supplies x-user-role, so requireRole is a real server-side gate, not a
// client-side hint). Without the gate the whole moderation queue would be
// readable by anyone who signs up.
router.post('/reports', ...customer, ctrl.reportUser);
router.get('/reports', gobhi, ctrl.listReports);
router.get('/reports/:id/context', gobhi, ctrl.getReportContext);
router.patch('/reports/users/:userId/release-hold', gobhi, ctrl.releaseHold);
router.patch('/reports/users/:userId/reinstate', gobhi, ctrl.reinstateUser);
router.patch('/reports/:id', gobhi, ctrl.reviewReport);

router.get('/moderation/gender-changes', gobhi, ctrl.listGenderChanges);
router.patch('/moderation/gender-changes/:userId/clear', gobhi, ctrl.clearGenderChange);

router.get('/league', ...customer, ctrl.getConsistencyLeague);

// Internal: auth-service calls this after a profile edit that touches
// gender/dateOfBirth/fitnessGoals, to keep buddy-service's denormalized
// cache from drifting (see services/buddyService.js#syncProfileFromAuth).
router.post('/internal/profile-sync/:userId', requireInternal, ctrl.syncProfile);

// Gamification Phase 4 (paired streaks) — challenge-service calls this to
// verify a customer-supplied matchId is real, active, and includes them
// before letting them opt a pair into a shared streak.
router.get('/internal/matches/:matchId/verify/:userId', requireInternal, ctrl.verifyMatchMembership);

// DPDPA erasure. Deliberately NOT feature-flagged: a user must always be
// able to have their data deleted, whatever else is switched off.
router.post('/internal/erase/:userId', requireInternal, ctrl.eraseUser);
// DPDPA access right (s.11) - the read twin of /internal/erase above. Called
// by auth-service's platform-wide export fan-out; internal only, never
// reachable through the gateway.
router.get('/internal/export/:userId', requireInternal, ctrl.exportUserInternal);

export default router;
