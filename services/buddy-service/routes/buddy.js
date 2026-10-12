import { Router } from 'express';
import { requireAuth, requireInternal, requireRole } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { uploadBuddyPhotos, MAX_BUDDY_PHOTOS } from '../utils/upload.js';
import * as ctrl from '../controllers/buddyController.js';

const router = Router();

// Every client-facing buddy route requires auth — matchmaking/chat should
// never be reachable anonymously. None of these are added to the gateway's
// PUBLIC_ROUTES.

// Customer routes: gated on the buddy flag + requireRole('customer').
// Admin routes keep requireRole('gobhi') with no flag check, and /internal/*
// gets neither.

// ---- Profile ----
// Customer-visible profile routes.
router.get('/profile/me', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.getMyProfile);
router.post('/profile', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.upsertProfile);
router.put('/profile', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.upsertProfile);
router.post('/profile/refresh', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.refreshProfile);

// ---- Photos ----
router.post('/photos', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), uploadBuddyPhotos.array('photos', MAX_BUDDY_PHOTOS), ctrl.addPhotos);
router.post('/photos/from-url', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.addPhotoFromUrl);
router.put('/photos/order', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.reorderPhotos);
router.delete('/photos/:photoId', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.deletePhoto);

// ---- Filters ----
router.get('/filters', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.getFilters);
router.put('/filters', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.updateFilters);

// ---- Discovery / swipes ----
router.get('/discover', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.getDiscoveryFeed);
router.post('/swipes', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.swipe);

router.get('/matches', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.getMatches);
router.get('/matches/:matchId/profile', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.getMatchedProfile);
router.post('/matches/:matchId/unmatch', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.unmatch);
router.get('/matches/:matchId/messages', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.getMessages);
router.post('/matches/:matchId/messages', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.sendMessage);

// ---- Blocks ----
router.post('/blocks', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.blockUser);
router.delete('/blocks/:userId', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.unblockUser);
router.get('/blocks', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.listBlocked);

// Reports. Filing one is any authenticated user; triaging them is gobhi-only
// (the gateway supplies x-user-role, so requireRole is a real server-side gate,
// not a client-side hint). Without the gate the whole moderation queue would be
// readable by anyone who signs up, which is why listReports/reviewReport are
// requireRole('gobhi') and not requireAuth.
// Note: POST /reports requires the buddy flag for customers; gobhi routes
// below do not.
router.post('/reports', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.reportUser);
router.get('/reports', requireRole('gobhi'), ctrl.listReports);
router.patch('/reports/:id', requireRole('gobhi'), ctrl.reviewReport);

router.get('/league', requireAuth, requireRole('customer'), requireFeatureFlag('buddy'), ctrl.getConsistencyLeague);

// Internal: auth-service calls this after a profile edit that touches
// gender/dateOfBirth/fitnessGoals, to keep buddy-service's denormalized
// cache from drifting (see services/buddyService.js#syncProfileFromAuth).
router.post('/internal/profile-sync/:userId', requireInternal);

// DPDPA erasure. Deliberately NOT feature-flagged: a user must always be
// able to have their data deleted, whatever else is switched off.
router.post('/internal/erase/:userId', requireInternal);
// DPDPA access right (s.11) - the read twin of /internal/erase above. Called
// by auth-service's platform-wide export fan-out; internal only, never
// reachable through the gateway.
router.get('/internal/export/:userId', requireInternal);

export default router;
