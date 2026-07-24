import { Router } from 'express';
import { requireAuth, requireInternal } from '../middleware/requireAuth.js';
import { uploadBuddyPhotos, MAX_BUDDY_PHOTOS } from '../utils/upload.js';
import * as ctrl from '../controllers/buddyController.js';

const router = Router();

// Every client-facing buddy route requires auth — matchmaking/chat should
// never be reachable anonymously. None of these are added to the gateway's
// PUBLIC_ROUTES.
router.get('/profile/me', requireAuth, ctrl.getMyProfile);
router.post('/profile', requireAuth, ctrl.upsertProfile);
router.put('/profile', requireAuth, ctrl.upsertProfile);
router.post('/profile/refresh', requireAuth, ctrl.refreshProfile);

router.post('/photos', requireAuth, uploadBuddyPhotos.array('photos', MAX_BUDDY_PHOTOS), ctrl.addPhotos);
router.post('/photos/from-url', requireAuth, ctrl.addPhotoFromUrl);
router.put('/photos/order', requireAuth, ctrl.reorderPhotos);
router.delete('/photos/:photoId', requireAuth, ctrl.deletePhoto);

router.get('/filters', requireAuth, ctrl.getFilters);
router.put('/filters', requireAuth, ctrl.updateFilters);

router.get('/discover', requireAuth, ctrl.getDiscoveryFeed);
router.post('/swipes', requireAuth, ctrl.swipe);

router.get('/matches', requireAuth, ctrl.getMatches);
router.get('/matches/:matchId/profile', requireAuth, ctrl.getMatchedProfile);
router.post('/matches/:matchId/unmatch', requireAuth, ctrl.unmatch);
router.get('/matches/:matchId/messages', requireAuth, ctrl.getMessages);
router.post('/matches/:matchId/messages', requireAuth, ctrl.sendMessage);

router.post('/blocks', requireAuth, ctrl.blockUser);
router.delete('/blocks/:userId', requireAuth, ctrl.unblockUser);
router.get('/blocks', requireAuth, ctrl.listBlocked);

// Internal: auth-service calls this after a profile edit that touches
// gender/dateOfBirth/fitnessGoals, to keep buddy-service's denormalized
// cache from drifting (see services/buddyService.js#syncProfileFromAuth).
router.post('/internal/profile-sync/:userId', requireInternal, ctrl.syncProfile);

export default router;
