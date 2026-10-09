import { Router } from 'express';
import {
  getOrCreateProfile,
  getProfile,
  getLinkedGym,
  updateProfile,
  updateAppMode,
  uploadProfilePicture,
} from '../controllers/userProfileController.js';
import {
  listAddresses,
  createAddress,
  deleteAddress,
} from '../controllers/addressController.js';
import { uploadProfilePicture as uploadProfilePictureMiddleware } from '../utils/upload.js';

const router = Router();

router.post('/', getOrCreateProfile);
// Declared above the /:userId routes: it is a different, member-scoped read
// (the linked-member home's gym) and must never be swallowed by
// router.get('/:userId') treating "linked-gym" as a user id.
router.get('/linked-gym/:gymId', getLinkedGym);
router.get('/:userId', getProfile);
router.put('/:userId', updateProfile);
// Separate from PUT /:userId on purpose — updateProfile DERIVES appMode from
// the onboarding answers, this is the user OVERRIDING that derivation, and
// only the override is worth logging.
router.put('/:userId/app-mode', updateAppMode);
router.post(
  '/:userId/profile-picture',
  uploadProfilePictureMiddleware.single('image'),
  uploadProfilePicture
);

router.get('/:userId/addresses', listAddresses);
router.post('/:userId/addresses', createAddress);
router.delete('/:userId/addresses/:addressId', deleteAddress);

export default router;
