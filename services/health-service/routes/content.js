import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import * as contentCtrl from '../controllers/contentController.js';

// Coach content (B15): exercise instructions and coach articles.
//
// Two gate shapes:
//
//   reader  any signed-in user. The content is the same for everyone and holds
//           no personal data, and the service only ever serves APPROVED rows,
//           so no flag or consent gate: the exercise screen falls back to its
//           old view on a 404, whatever flags are on.
//   admin   the gobhi role. Founder review of generated content — edit,
//           approve, reject. Never flag-gated, so review can happen while the
//           coach journey is still off.
const router = Router();

const reader = [requireAuth];
const admin = [requireRole('gobhi')];

router.get('/content/exercises/:exerciseId', ...reader, contentCtrl.getExercise);
router.get('/content/articles', ...reader, contentCtrl.listArticles);
router.get('/content/articles/:slug', ...reader, contentCtrl.getArticle);

router.get('/content/admin/queue', ...admin, contentCtrl.adminQueue);
router.put('/content/admin/exercises/:id', ...admin, contentCtrl.editExercise);
router.put('/content/admin/articles/:id', ...admin, contentCtrl.editArticle);
router.post('/content/admin/:type/:id/approve', ...admin, contentCtrl.approve);
router.post('/content/admin/:type/:id/reject', ...admin, contentCtrl.reject);

export default router;
