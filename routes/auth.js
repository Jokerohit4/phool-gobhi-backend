import { Router } from 'express';
const router = Router();
import { signup, login, deleteUser, refreshToken } from '../controllers/authController.js';
import verifyToken from '../middlewares/verifyToken.js';

router.post('/signup', signup);
router.post('/login', login);
router.post('/refresh-token', refreshToken);  // ✅ New
router.delete('/delete', verifyToken, deleteUser);

export default router;
