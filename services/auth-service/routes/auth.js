import { Router } from 'express';
const router = Router();
import { signup, login, deleteUser, refreshToken, sendOtp, verifyOtp, verifyFirebaseToken, googleSignIn, getOtpConfig, getMe, getUserInternal, updateFcmToken } from '../controllers/authController.js';
import verifyToken from '../middleware/verifyToken.js';
import requireInternal from '../middleware/requireInternal.js';

router.post('/signup', signup);
router.post('/login', login);
router.post('/refresh-token', refreshToken);
router.delete('/delete', verifyToken, deleteUser);
router.post('/forgot-password', async (req, res) => {
  // TODO: Implement email sending (e.g. Nodemailer + SMTP)
  // For now, always return success so the frontend works
  res.json({ message: 'If an account exists for this email, a password reset link has been sent.' });
});
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/verify-firebase-token', verifyFirebaseToken);
router.post('/google', googleSignIn);
router.get('/otp-config', getOtpConfig);
router.get('/me', verifyToken, getMe);
router.get('/internal/:id', requireInternal, getUserInternal);
router.post('/fcm-token', verifyToken, updateFcmToken);

export default router;
