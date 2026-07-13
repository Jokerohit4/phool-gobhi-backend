import { Router } from 'express';
import {
  getOrCreateProfile,
  getProfile,
  updateProfile,
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
router.get('/:userId', getProfile);
router.put('/:userId', updateProfile);
router.post(
  '/:userId/profile-picture',
  uploadProfilePictureMiddleware.single('image'),
  uploadProfilePicture
);

router.get('/:userId/addresses', listAddresses);
router.post('/:userId/addresses', createAddress);
router.delete('/:userId/addresses/:addressId', deleteAddress);

export default router;
