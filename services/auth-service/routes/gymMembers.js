import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import { getProfile, patchRecord, postPayment, removePayment } from '../controllers/gymMemberController.js';

// The partner's member profile (mounted at '/', flat under the gateway's
// /api/auth prefix). All partner-only and ownership-checked, and only for an
// approved, active member of the gym:
//
//   GET    /gym/:gymId/members/:userId/profile             -> 200 { data: { customer, link, record, payments, summary, statedMembershipEndsOn } }
//   PATCH  /gym/:gymId/members/:userId/record              -> 200 { data: { record } }      (partial; null clears a field)
//   POST   /gym/:gymId/members/:userId/payments            -> 201 { data: { payment, summary } }
//   DELETE /gym/:gymId/members/:userId/payments/:paymentId -> 200 { data: { summary } }
//
// Distinct paths from GET /gym/:gymId/members (the roster) and
// DELETE /gym/:gymId/members/:userId (remove a member) in routes/auth.js and
// routes/gymLinks.js, so mount order does not matter.

const router = Router();

router.get('/gym/:gymId/members/:userId/profile', verifyToken, getProfile);
router.patch('/gym/:gymId/members/:userId/record', verifyToken, patchRecord);
router.post('/gym/:gymId/members/:userId/payments', verifyToken, postPayment);
router.delete('/gym/:gymId/members/:userId/payments/:paymentId', verifyToken, removePayment);

export default router;
