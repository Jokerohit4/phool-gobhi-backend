import { Router } from 'express';
import { getOrCreateProfile, getProfile, updateProfile } from '../controllers/userProfileController.js';

const router = Router();

router.post('/', getOrCreateProfile);
router.get('/:userId', getProfile);
router.put('/:userId', updateProfile);

export default router;
