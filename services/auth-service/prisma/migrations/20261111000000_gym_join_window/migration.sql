-- Hand-authored, additive migration: a gym owner's time-boxed "approve every
-- join" window. While autoApproveUntil is in the future, a presence-verified
-- entrance scan joins the member as approved instead of leaving a pending
-- request. One row per gym; closing a window deletes the row.
--
-- New table only, no change to existing tables: safe to apply online.
-- Reconcile against dev/prod before applying, same caveat as the preceding
-- hand-authored migrations (no shadow DB here to run `prisma migrate dev`).

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "auth"."GymJoinWindow" (
  "gymId"             INTEGER      NOT NULL,
  "autoApproveUntil"  TIMESTAMP(3) NOT NULL,
  "openedByPartnerId" INTEGER,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GymJoinWindow_pkey" PRIMARY KEY ("gymId")
);
