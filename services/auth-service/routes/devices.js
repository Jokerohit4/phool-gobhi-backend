import { Router } from 'express';

// Device registry — EMPTY STUB as of A1 (2026-10-16).
//
// This router is intentionally empty. It exists so the paths below are reserved
// under /api/auth before the Group B owner (B1) implements them, and so
// app.js's mount does not have to change when that lands:
//
//   POST /devices                          (verifyToken)  upsert UserDevice by
//                                          userId + installId, touch lastSeenAt
//   GET  /internal/devices/:installId/users  (requireInternal) -> { userIds }
//   GET  /internal/users/:id/devices         (requireInternal) -> { installIds }
//
// The UserDevice model backing them is added by A1 (prisma/schema.prisma). Do
// not add routes here in A1 — B1 owns the handlers.

const router = Router();

export default router;
