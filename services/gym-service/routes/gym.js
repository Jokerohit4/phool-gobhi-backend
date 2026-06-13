import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { uploadGymImage, uploadGymDoc } from '../utils/upload.js';
import * as ctrl from '../controllers/gymController.js';

const router = Router();

// Public routes (no auth needed)
router.get('/', ctrl.listGyms);
router.get('/internal/:id', ctrl.getGymInternal);
router.get('/:id', ctrl.getGym);
router.get('/:id/slots', ctrl.getGymSlots);
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

// Admin-only route — requires role 'gobhi'
// To approve: create an account with role:'gobhi' via POST /api/auth/signup, login, use the JWT
router.put('/:id/approve', requireRole('gobhi'), ctrl.approveGym);

// Customer routes
router.post('/:id/reviews', requireRole('customer'), ctrl.addReview);

// Slot block routes (partner only)
router.get('/:id/blocks', requireRole('partner'), ctrl.getSlotBlocks);
router.post('/:id/blocks', requireRole('partner'), ctrl.createSlotBlock);
router.delete('/:id/blocks/:blockId', requireRole('partner'), ctrl.deleteSlotBlock);

export default router;
