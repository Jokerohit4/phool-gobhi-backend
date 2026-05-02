import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { createUser, getUser, updateUser } from '../controllers/userController.js';

const router = Router();

router.post('/', createUser); // called after signup — no auth required
router.get('/:userId', requireAuth, getUser);
router.put('/:userId', requireAuth, updateUser);

export default router;
