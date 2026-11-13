-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Attendance-SaaS monthly bill: counts users who joined a gym in a given
-- month (where linkedGymId = X AND createdAt within the month). Without this
-- index the admin/partner bill surfaces would scan every linked user.

CREATE INDEX IF NOT EXISTS "User_linkedGymId_createdAt_idx" ON "auth"."User"("linkedGymId", "createdAt");