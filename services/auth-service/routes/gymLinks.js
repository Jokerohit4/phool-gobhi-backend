import { Router } from 'express';

// Gym links — EMPTY STUB as of A1 (2026-10-16).
//
// This router is intentionally empty. It exists so the paths below are reserved
// under /api/auth before the Group B owner (B2) implements them, and so
// app.js's mount does not have to change when that lands:
//
//   POST   /gym-links/self                (verifyToken, selfLinkGym flag)
//                                          -> 200 { link } | 409 SELF_LINK_BLOCKED
//                                             | 429 SELF_LINK_LIMIT
//   DELETE /gym-links/self                (verifyToken, selfLinkGym flag) -> 204
//   POST   /me/notice/clear               (verifyToken) -> 204, clears gymLinkNotice
//   POST   /internal/gym-links/checked-in (requireInternal) -> 204, stamps
//                                          firstVerifiedCheckinAt on the active link
//
// The GymLink model + GymLinkSource enum backing them are added by A1
// (prisma/schema.prisma). Do not add routes here in A1 — B2 owns the handlers.

const router = Router();

export default router;
