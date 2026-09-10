-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Attendance-SaaS re-engagement sweep: set once the sweep has resolved this
-- gym-linked user (nudged, or found already active) — never reset, so a
-- resolved user is never re-checked on a later sweep run.

ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "reengagementNudgedAt" TIMESTAMP(3);
