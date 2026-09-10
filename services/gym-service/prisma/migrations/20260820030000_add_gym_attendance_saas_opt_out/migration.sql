-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Partner self-service opt-out of the attendance-SaaS program. Defaults to
-- false (opted in) for every existing gym, matching current behavior —
-- nothing changes until a partner explicitly opts out.

ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "attendanceSaasOptedOut" BOOLEAN NOT NULL DEFAULT false;
