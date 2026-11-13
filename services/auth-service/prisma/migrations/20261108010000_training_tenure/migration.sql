-- Hand-authored, additive migration: how long a user has been training.
-- No DATABASE_URL/shadow DB is available here to run `prisma migrate dev`, so
-- reconcile against dev/prod before applying — same caveat as the preceding
-- migrations.
--
-- A new enum and one new nullable column, no backfill and no constraint changes
-- on existing data: safe to apply online. lock_timeout bounds how long the
-- ALTER waits for a table lock.

SET lock_timeout = '3s';

-- CreateEnum (idempotent: dev and prod migrate independently)
DO $$ BEGIN
  CREATE TYPE "auth"."TrainingTenure" AS ENUM ('under_3_months', 'three_to_12_months', 'one_to_3_years', 'over_3_years');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "trainingTenure" "auth"."TrainingTenure";
