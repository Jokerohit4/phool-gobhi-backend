import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import requireInternal from '../middleware/requireInternal.js';
import {
  selfLink,
  leaveGymLink,
  removeGymMember,
  clearGymLinkNotice,
  gymLinkCheckedIn,
  unclaimedGymClaimed,
  acceptGymClaimPrompt,
  dismissGymClaimPrompt,
} from '../controllers/gymLinkController.js';

// Gym links (coach-journey B2) — mounted at '/' beside authRoutes/deviceRoutes
// in app.js, so these are flat under the gateway's /api/auth prefix:
//
//   POST   /gym-links/self                        (verifyToken, flag-gated)  -> 200 { link }
//   DELETE /gym-links/self                        (verifyToken, flag-gated)  -> 204
//   DELETE /gym/:gymId/members/:userId            (verifyToken, partner-only) -> 204
//   POST   /me/notice/clear                       (verifyToken)              -> 204
//   POST   /gym-links/claim-prompt/accept         (verifyToken)              -> 200 { linkedGymId }
//   POST   /gym-links/claim-prompt/dismiss        (verifyToken)              -> 204
//   POST   /internal/gym-links/checked-in         (requireInternal)          -> 204
//   POST   /internal/unclaimed-gym-claimed        (requireInternal)          -> 204
//
// The partner-removal route is a distinct HTTP method from the existing
// GET /gym/:gymId/members in routes/auth.js, so mount order does not matter.
// The self-link flag is checked in the controller (it needs the DB to read an
// admin's override), not here.

const router = Router();

router.post('/gym-links/self', verifyToken, selfLink);
router.delete('/gym-links/self', verifyToken, leaveGymLink);
router.delete('/gym/:gymId/members/:userId', verifyToken, removeGymMember);
router.post('/me/notice/clear', verifyToken, clearGymLinkNotice);
router.post('/gym-links/claim-prompt/accept', verifyToken, acceptGymClaimPrompt);
router.post('/gym-links/claim-prompt/dismiss', verifyToken, dismissGymClaimPrompt);
router.post('/internal/gym-links/checked-in', requireInternal, gymLinkCheckedIn);
router.post('/internal/unclaimed-gym-claimed', requireInternal, unclaimedGymClaimed);

export default router;
