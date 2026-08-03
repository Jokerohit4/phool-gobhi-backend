-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Referral program: referralCode is each user's own shareable code
-- (deterministic, set right after creation); referredByUserId is who
-- referred them, set once at creation and never mutated after.

ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "referralCode" TEXT;
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "referredByUserId" INTEGER;

DO $$ BEGIN
  CREATE UNIQUE INDEX "User_referralCode_key" ON "auth"."User"("referralCode");
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "auth"."User" ADD CONSTRAINT "User_referredByUserId_fkey" FOREIGN KEY ("referredByUserId") REFERENCES "auth"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
