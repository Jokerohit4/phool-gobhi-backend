-- Hand-authored, additive migration for the coach-journey cutover (2026-10-16).
-- No DATABASE_URL/shadow DB is available here to run `prisma migrate dev`, so
-- reconcile against dev/prod before applying — same caveat as the preceding
-- migrations.
--
-- Everything here is additive: new nullable columns (no backfill) plus two new
-- tables and one enum. No existing column changes type or gains a constraint,
-- so this is safe to apply online. lock_timeout bounds how long the ALTERs wait
-- for a table lock rather than blocking writes on User indefinitely.

SET lock_timeout = '3s';

-- CreateEnum (idempotent: dev and prod migrate independently)
DO $$ BEGIN
  CREATE TYPE "auth"."GymLinkSource" AS ENUM ('self', 'gym_qr');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable — User coach-journey gym-link fields. All nullable except
-- firstVisitBadgeConsent, which defaults false so existing rows need no
-- backfill and null-vs-false stays unambiguous.
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "homeUnclaimedGymId" INTEGER;
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "pendingGymPromptGymId" INTEGER;
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "gymLinkNotice" TEXT;
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "firstVisitBadgeConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "firstVisitBadgeConsentAt" TIMESTAMP(3);

-- CreateTable — customer↔gym membership links.
CREATE TABLE IF NOT EXISTS "auth"."GymLink" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "source" "auth"."GymLinkSource" NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstVerifiedCheckinAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedByPartnerId" INTEGER,
    "selfRelinkBlocked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GymLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GymLink_gymId_linkedAt_idx"
  ON "auth"."GymLink"("gymId", "linkedAt");
CREATE INDEX IF NOT EXISTS "GymLink_userId_idx"
  ON "auth"."GymLink"("userId");

-- CreateTable — one row per app install a user has signed in on.
CREATE TABLE IF NOT EXISTS "auth"."UserDevice" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "installId" TEXT NOT NULL,
    "platform" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserDevice_userId_installId_key"
  ON "auth"."UserDevice"("userId", "installId");
CREATE INDEX IF NOT EXISTS "UserDevice_installId_idx"
  ON "auth"."UserDevice"("installId");
