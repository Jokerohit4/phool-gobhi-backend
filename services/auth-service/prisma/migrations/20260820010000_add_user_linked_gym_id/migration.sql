-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Attendance-SaaS wedge: set once at account creation when signup came from
-- a gym-specific "join us" QR/link, never mutated after (same contract as
-- referredByUserId). Unenforced cross-service reference — Gym lives in
-- gym-service's own database.

ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "linkedGymId" INTEGER;
