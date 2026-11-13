-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Mode-switch log (2026-09-18). Purely additive. Exists to answer whether the
-- onboarding branch put people in the right place, which is not something the
-- current-value column on User can tell you.

CREATE TABLE IF NOT EXISTS "auth"."AppModeHistory" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "fromMode" "auth"."AppMode",
    "toMode" "auth"."AppMode" NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppModeHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppModeHistory_userId_createdAt_idx"
  ON "auth"."AppModeHistory"("userId", "createdAt");
