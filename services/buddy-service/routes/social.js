import { Router } from 'express';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary.js';
import { getUserInternal } from '../services/authClient.js';
import { createSocialService } from '../services/socialService.js';
import { requireRole } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';

const router = Router();
const service = createSocialService({ prisma: new PrismaClient(), cloudinary, getUserInternal });
const customer = [requireRole('customer'), requireFeatureFlag('buddy')];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 5 } });
const route = run => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: await run(req) ?? null }); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.error : 'Could not load or update this buddy profile' }); }
};

// The only anonymous buddy route: explicit consent, minimal fields, read-only.
router.get('/public/:code', requireFeatureFlag('buddy'), route(req => service.view(null, req.params.code)));
router.get('/social/me', ...customer, route(req => service.me(req.userId)));
router.put('/social/me', ...customer, route(req => service.settings(req.userId, req.body || {})));
router.get('/social/following', ...customer, route(req => service.following(req.userId)));
router.post('/social/records', ...customer, upload.single('media'), route(req => service.addRecord(req.userId, req.body || {}, req.file)));
router.delete('/social/records/:id', ...customer, route(req => service.deleteRecord(req.userId, Number(req.params.id))));
router.get('/social/:code', ...customer, route(req => service.view(req.userId, req.params.code)));
router.post('/social/:code/follow', ...customer, route(req => service.follow(req.userId, req.params.code, true)));
router.delete('/social/:code/follow', ...customer, route(req => service.follow(req.userId, req.params.code, false)));
router.use((err, req, res, next) => {
  if (!(err instanceof multer.MulterError)) return next(err);
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Media must be smaller than 30 MB' : 'Attach one photo or video per PR' });
});
export default router;
