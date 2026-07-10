import { Router } from 'express';
import { requireAuth, requireRole, requireInternal } from '../middleware/requireAuth.js';
import { uploadGymImage, uploadGymDoc } from '../utils/upload.js';
import * as ctrl from '../controllers/gymController.js';

const router = Router();

// Public routes (no auth needed)
router.get('/', ctrl.listGyms);
// Internal service-to-service only (e.g. booking-service resolving a gym by
// id) — returns the full row with no approval/active filtering, so this must
// never be reachable without the shared secret.
router.get('/internal/:id', requireInternal, ctrl.getGymInternal);
// Internal service-to-service: partner onboarding summary (auth-service, at login)
router.get('/internal/partner/:partnerId/summary', requireInternal, ctrl.getPartnerGymSummaryInternal);
router.get('/:id', ctrl.getGym);
router.get('/:id/slots', ctrl.getGymSlots);
router.get('/:id/availability', ctrl.getGymAvailability);
router.get('/:id/reviews', ctrl.getGymReviews);

// Partner routes
router.get('/partner/mine', requireRole('partner'), ctrl.getPartnerGyms);
router.post('/', requireRole('partner'), ctrl.createGym);
router.put('/:id', requireRole('partner'), ctrl.updateGym);
router.delete('/:id', requireRole('partner'), ctrl.deleteGym);
router.post('/:id/images', requireRole('partner'), uploadGymImage.single('image'), ctrl.addGymImage);
router.delete('/:id/images/:imageId', requireRole('partner'), ctrl.deleteGymImage);
// Brand/verification documents (field 'file'); stored as URLs in Gym.brandDocs[]
router.post('/:id/docs', requireRole('partner'), uploadGymDoc.single('file'), ctrl.addGymDoc);
router.delete('/:id/docs', requireRole('partner'), ctrl.deleteGymDoc);
router.post('/upload', requireAuth, uploadGymImage.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: req.file.path });
});

// Admin-only routes — require role 'gobhi'
// To approve: create an account with role:'gobhi' via POST /api/auth/signup, login, use the JWT
// Body: {} or {approved:true} to approve; {approved:false, reason:"..."} to reject (reason required)
router.put('/:id/approve', requireRole('gobhi'), ctrl.approveGym);
// List all gyms regardless of owner/approval status; ?status=pending|approved|rejected
router.get('/admin/all', requireRole('gobhi'), ctrl.listGymsAdmin);
// Single-gym lookup that doesn't 404 on pending/rejected gyms (unlike GET /:id above)
router.get('/admin/:id', requireRole('gobhi'), ctrl.getGymAdmin);

// Customer routes
router.post('/:id/reviews', requireRole('customer'), ctrl.addReview);

// Slot block routes (partner only)
router.get('/:id/blocks', requireRole('partner'), ctrl.getSlotBlocks);
router.post('/:id/blocks', requireRole('partner'), ctrl.createSlotBlock);
router.delete('/:id/blocks/:blockId', requireRole('partner'), ctrl.deleteSlotBlock);

export default router;
