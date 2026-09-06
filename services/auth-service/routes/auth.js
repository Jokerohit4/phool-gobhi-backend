import { Router } from 'express';
const router = Router();
import { signup, login, deleteUser, refreshToken, logout, sendOtp, verifyOtp, verifyFirebaseToken, googleSignIn, getOtpConfig, getOtpConfigAdmin, updateOtpConfigAdmin, listOtpSkipAllowlist, addOtpSkipAllowlist, removeOtpSkipAllowlist, getAppConfig, getAppConfigAdmin, updateAppConfigAdmin, getLaunchStatus, getLaunchGateAdmin, updateLaunchGateAdmin, getProfileCompletionBonusAdmin, updateProfileCompletionBonusAdmin, getMe, updateMe, getUserInternal, getUserByPhoneInternal, getUsersBatchInternal, runAttendanceSaasReengagementSweep, listAttendanceSaasMembers, listGymMembersForPartner, getBankAccount, updateBankAccount, getBankAccountAdmin, updateFcmToken, updateLeaderboardOptIn, listMyCollectibles, collectCollectible, listStaff, createStaff, updateStaffStatus, createTrainer, listTrainers, updateTrainerStatus } from '../controllers/authController.js';
import { checkContact, listContacts, addContact, removeContact } from '../controllers/pitchAccessController.js';
import { submitContact, listContact, updateContactRead } from '../controllers/contactController.js';
import {
  listPublicJobOpenings,
  listAdminJobOpenings,
  addJobOpening,
  updateJobOpeningStatus,
  removeJobOpening,
} from '../controllers/jobOpeningController.js';
import {
  submitApplication,
  listApplications,
  updateApplicationRead,
} from '../controllers/jobApplicationController.js';
import {
  listPublicPlatformReviews,
  listAdminPlatformReviews,
  submitPlatformReview,
  updatePlatformReviewApproval,
  removePlatformReview,
} from '../controllers/platformReviewController.js';
import verifyToken from '../middleware/verifyToken.js';
import requireInternal from '../middleware/requireInternal.js';
import requireGobhi from '../middleware/requireGobhi.js';
import requireCustomer from '../middleware/requireCustomer.js';
import { uploadResume } from '../utils/gcsResume.js';

router.post('/signup', signup);
router.post('/login', login);
router.post('/refresh-token', refreshToken);
router.post('/logout', logout);
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
// Admin portal's raw view/edit of the OTP provider + skip-mode allowlist (Settings page).
router.get('/otp-config/admin', requireGobhi, getOtpConfigAdmin);
router.put('/otp-config/admin', requireGobhi, updateOtpConfigAdmin);
router.get('/otp-config/admin/skip-allowlist', requireGobhi, listOtpSkipAllowlist);
router.post('/otp-config/admin/skip-allowlist', requireGobhi, addOtpSkipAllowlist);
router.delete('/otp-config/admin/skip-allowlist/:id', requireGobhi, removeOtpSkipAllowlist);
// Force/soft-update check — public, called by both apps before login.
router.get('/app-config', getAppConfig);
// Admin portal's raw config view/edit (Settings page)
router.get('/app-config/admin', requireGobhi, getAppConfigAdmin);
router.put('/app-config/admin', requireGobhi, updateAppConfigAdmin);
// Public — website launch gate, see getLaunchStatus.
router.get('/launch-status', getLaunchStatus);
// Admin portal's raw view/edit of the launch gate (Settings page).
router.get('/launch-gate/admin', requireGobhi, getLaunchGateAdmin);
router.put('/launch-gate/admin', requireGobhi, updateLaunchGateAdmin);
// Admin portal's view/edit of the one-time profile-completion wallet bonus
// amount (Settings page). Also surfaced to the customer app via the public
// /app-config features block.
router.get('/profile-completion-bonus/admin', requireGobhi, getProfileCompletionBonusAdmin);
router.put('/profile-completion-bonus/admin', requireGobhi, updateProfileCompletionBonusAdmin);
router.get('/me', verifyToken, getMe);
router.patch('/me', verifyToken, updateMe);
router.get('/internal/:id', requireInternal, getUserInternal);
router.get('/internal/by-phone/:phone', requireInternal, getUserByPhoneInternal);
router.post('/internal/users/batch', requireInternal, getUsersBatchInternal);
// Scheduled trigger (see .github/workflows) — nudges gym-linked signups
// with no activity N days after registering.
router.post('/internal/attendance-saas/reengagement-sweep', requireInternal, runAttendanceSaasReengagementSweep);
// Gobhi-only: admin's attendance-SaaS member roster for one gym.
router.get('/admin/attendance-saas/members/:gymId', requireGobhi, listAttendanceSaasMembers);
// Partner-facing equivalent (own gym, ownership-checked, no phone) — closes
// the gap-analysis finding that the member roster existed only gobhi-side.
router.get('/gym/:gymId/members', verifyToken, listGymMembersForPartner);
// Partner-only: create/manage this gym's own personal trainers. The trainer
// then logs in through the normal /send-otp + /verify-otp flow above.
router.post('/gym/:gymId/trainers', verifyToken, createTrainer);
router.get('/gym/:gymId/trainers', verifyToken, listTrainers);
router.patch('/gym/:gymId/trainers/:trainerId', verifyToken, updateTrainerStatus);
// Partner self-service bank details, for the attendance-SaaS bank-settlement
// flow (wallet-service's PartnerBankSettlement) — admin needs the full
// details to actually make the manual transfer, hence the admin route too.
router.get('/bank-account', verifyToken, getBankAccount);
router.put('/bank-account', verifyToken, updateBankAccount);
router.get('/admin/bank-account/:userId', requireGobhi, getBankAccountAdmin);
router.post('/fcm-token', verifyToken, updateFcmToken);
// Per-gym attendance leaderboards (booking-service) are opt-in.
router.put('/leaderboard-opt-in', verifyToken, updateLeaderboardOptIn);
// Map collectibles (veggie pickups) -- standalone currency, no coins/gyms
// involved. Spawn points are deterministic client-side; these just record
// which ids this customer has found.
router.get('/collectibles/mine', requireCustomer, listMyCollectibles);
router.post('/collectibles/:collectibleId/collect', requireCustomer, collectCollectible);

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

// Website /careers job listings — public read (active only), staff-managed
router.get('/jobs', listPublicJobOpenings);
router.get('/admin/jobs', requireGobhi, listAdminJobOpenings);
router.post('/admin/jobs', requireGobhi, addJobOpening);
router.patch('/admin/jobs/:id', requireGobhi, updateJobOpeningStatus);
router.delete('/admin/jobs/:id', requireGobhi, removeJobOpening);

// Job applications submitted against a listing — public write, staff-only read
router.post('/jobs/:jobOpeningId/apply', uploadResume.single('resume'), submitApplication);
router.get('/admin/job-applications', requireGobhi, listApplications);
router.patch('/admin/job-applications/:id', requireGobhi, updateApplicationRead);

// Platform-wide reviews ("What users say about us" on /testimonials) — public
// read (approved only), customer-submitted (one per customer, upsert), gobhi-moderated.
router.get('/platform-reviews', listPublicPlatformReviews);
router.post('/platform-reviews', requireCustomer, submitPlatformReview);
router.get('/admin/platform-reviews', requireGobhi, listAdminPlatformReviews);
router.patch('/admin/platform-reviews/:id', requireGobhi, updatePlatformReviewApproval);
router.delete('/admin/platform-reviews/:id', requireGobhi, removePlatformReview);

export default router;
