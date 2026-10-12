-- Reports + match expiry + buddy safety (buddy-service moderation, 2026-10-15).
--
-- Hand-authored, and idempotent by design. Same caveat as the preceding
-- migration: this service's baseline was recorded with `migrate resolve
-- --applied` and never executed (the real dev/prod DBs were built with
-- `db push`), so the actual table state cannot be inferred from migration
-- history. Every statement below is therefore written to be safe to run twice
-- and safe to run against a DB that already has part of it.
--
-- Postgres has no `CREATE TYPE IF NOT EXISTS`, hence the DO blocks — the
-- duplicate_object guard is what makes re-running a no-op instead of an error.
--
-- Name is service-prefixed on purpose: all services share ONE physical
-- Postgres database and ONE global _prisma_migrations table keyed by
-- migration_name alone (see the baseline header), so a generic name here
-- would collide with another service's.

-- ---- ReportSeverity enum + backfill ------------------------------------

DO $$ BEGIN
  CREATE TYPE "buddy"."ReportSeverity" AS ENUM ('normal', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE "buddy"."Report" SET severity = 'high' WHERE reason IN ('threat','underage');

-- ---- ReportSeverity column on Report -----------------------------------

ALTER TABLE "buddy"."Report"
  ADD COLUMN IF NOT EXISTS "severity" "buddy"."ReportSeverity" NOT NULL DEFAULT 'normal';

-- ---- BuddyProfile new columns ------------------------------------------

ALTER TABLE "buddy"."BuddyProfile"
  ADD COLUMN IF NOT EXISTS "moderationHoldAt" TIMESTAMP(3);

ALTER TABLE "buddy"."BuddyProfile"
  ADD COLUMN IF NOT EXISTS "genderChangedAt" TIMESTAMP(3);

ALTER TABLE "buddy"."BuddyProfile"
  ADD COLUMN IF NOT EXISTS "genderChangedTo" "buddy"."Gender";

ALTER TABLE "buddy"."BuddyProfile"
  ADD COLUMN IF NOT EXISTS "genderChangeClearedAt" TIMESTAMP(3);

ALTER TABLE "buddy"."BuddyProfile"
  ADD COLUMN IF NOT EXISTS "womenOnlyBlocked" BOOLEAN NOT NULL DEFAULT false;

-- ---- BuddyFilter.new column --------------------------------------------

ALTER TABLE "buddy"."BuddyFilter"
  ADD COLUMN IF NOT EXISTS "womenOnly" BOOLEAN NOT NULL DEFAULT false;