import { Router } from 'express';
const router = Router();
import { signup, login, deleteUser, refreshToken, sendOtp, verifyOtp, verifyFirebaseToken, googleSignIn, getOtpConfig, getMe, getUserInternal, getUsersBatchInternal, updateFcmToken, listStaff, createStaff, updateStaffStatus } from '../controllers/authController.js';
import { checkContact, listContacts, addContact, removeContact } from '../controllers/pitchAccessController.js';
import { submitContact, listContact, updateContactRead } from '../controllers/contactController.js';
import verifyToken from '../middleware/verifyToken.js';
import requireInternal from '../middleware/requireInternal.js';
import requireGobhi from '../middleware/requireGobhi.js';

router.post('/signup', signup);
router.post('/login', login);
router.post('/refresh-token', refreshToken);
router.delete('/delete', verifyToken, deleteUser);
router.post('/forgot-password', async (req, res) => {
  // Only email/password accounts (gobhi/staff, via /admin/staff — customer
  // and partner accounts are phone+OTP only) would ever need this. No email
  // delivery integration exists yet, so this returns an honest "not
  // implemented" rather than silently claiming an email was sent.
  res.status(501).json({ error: 'Password reset isn\'t available yet — contact an admin to reset a staff account.' });
});
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/verify-firebase-token', verifyFirebaseToken);
router.post('/google', googleSignIn);
router.get('/otp-config', getOtpConfig);
router.get('/me', verifyToken, getMe);
router.get('/internal/:id', requireInternal, getUserInternal);
router.post('/internal/users/batch', requireInternal, getUsersBatchInternal);
router.post('/fcm-token', verifyToken, updateFcmToken);

// Pitch-deck access allowlist (moved off a hardcoded file in the website repo)
router.post('/pitch-access/check', checkContact);
router.get('/admin/pitch-access', requireGobhi, listContacts);
router.post('/admin/pitch-access', requireGobhi, addContact);
router.delete('/admin/pitch-access/:id', requireGobhi, removeContact);

// Staff (gobhi) account management, driven by the admin portal's Staff page
router.get('/admin/staff', requireGobhi, listStaff);
router.post('/admin/staff', requireGobhi, createStaff);
router.patch('/admin/staff/:id', requireGobhi, updateStaffStatus);

// Website /contact form submissions — public write, staff-only read
router.post('/contact', submitContact);
router.get('/admin/contact-messages', requireGobhi, listContact);
router.patch('/admin/contact-messages/:id', requireGobhi, updateContactRead);

export default router;
