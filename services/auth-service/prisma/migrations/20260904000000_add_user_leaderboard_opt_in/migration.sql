-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Per-gym attendance leaderboards are opt-in; defaults false for every
-- existing row so nobody's past check-ins become visible without asking.

ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "leaderboardOptIn" BOOLEAN NOT NULL DEFAULT false;
