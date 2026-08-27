-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying.
--
-- A gym's own personal trainer — a new role, created only by the employing
-- partner (never public self-signup, same posture as gobhi), logging in via
-- the existing phone+OTP flow. Distinct from GobhiType's "trainer" job-title
-- label on an internal Phool Gobhi staff account.

ALTER TYPE "auth"."Role" ADD VALUE IF NOT EXISTS 'trainer';

ALTER TABLE "auth"."User"
  ADD COLUMN IF NOT EXISTS "trainerGymId" INTEGER;
