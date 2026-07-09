import { Router } from 'express';
import {
  getOrCreateProfile,
  getProfile,
  updateProfile,
  uploadProfilePicture,
} from '../controllers/userProfileController.js';
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

export default router;
