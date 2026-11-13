import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import requireInternal from '../middleware/requireInternal.js';
import { registerDevice, getUsersForInstall, getDevicesForUser } from '../controllers/deviceController.js';

// Device registry (coach-journey B1) — mounted at '/' beside authRoutes in
// app.js, so these are flat under the gateway's /api/auth prefix:
//
//   POST /devices                            (verifyToken)    upsert UserDevice by
//                                            userId + installId, touch lastSeenAt, 204
//   GET  /internal/devices/:installId/users  (requireInternal) -> { userIds: [Int] }
//   GET  /internal/users/:id/devices         (requireInternal) -> { installIds: [String] }
//
// The UserDevice model backing them is added by A1 (prisma/schema.prisma).

const router = Router();

router.post('/devices', verifyToken, registerDevice);
router.get('/internal/devices/:installId/users', requireInternal, getUsersForInstall);
router.get('/internal/users/:id/devices', requireInternal, getDevicesForUser);

export default router;
