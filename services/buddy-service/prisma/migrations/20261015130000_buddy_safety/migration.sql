SET lock_timeout = '3s';

-- Buddy safety (W7, 2026-10-15): report severity, moderation hold,
-- gender-change guard and women-only mode.
--
-- Hand-authored, and idempotent by design. Same caveat as the preceding
-- migrations: this service's baseline was recorded with `migrate resolve
-- --applied` and never executed (the real dev/prod DBs were built with
-- `db push`), so the actual table state cannot be inferred from migration
-- history. Every statement below is therefore written to be safe to run twice
-- and safe to run against a DB that already has part of it.
--
-- Only nullable or defaulted columns are added, so this is safe to apply
-- online and auth-service (W5) and buddy-service can deploy in either order.
-- lock_timeout bounds how long each ALTER waits for its table lock, so a busy
-- table fails the migration fast instead of queueing every query behind it.
--
-- Postgres has no `CREATE TYPE IF NOT EXISTS`, hence the DO block — the
-- duplicate_object guard is what makes re-running a no-op instead of an error.
--
-- Name is service-prefixed on purpose: all services share ONE physical
-- Postgres database and ONE global _prisma_migrations table keyed by
-- migration_name alone (see the baseline header), so a generic name here
-- would collide with another service's.

-- ---- ReportSeverity enum -----------------------------------------------

-- Declaration order is the sort order: normal < high, so ORDER BY severity
-- DESC puts high-severity reports first in the admin queue.
DO $$ BEGIN
  CREATE TYPE "buddy"."ReportSeverity" AS ENUM ('normal', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- Report.severity ---------------------------------------------------

ALTER TABLE "buddy"."Report"
  ADD COLUMN IF NOT EXISTS "severity" "buddy"."ReportSeverity" NOT NULL DEFAULT 'normal';

-- ---- BuddyProfile: moderation hold + gender-change guard ---------------

ALTER TABLE "buddy"."BuddyProfile"
  ADD COLUMN IF NOT EXISTS "moderationHoldAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "genderChangedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "genderChangedTo" "buddy"."Gender",
  ADD COLUMN IF NOT EXISTS "genderChangeClearedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "womenOnlyBlocked" BOOLEAN NOT NULL DEFAULT false;

-- ---- BuddyFilter.womenOnly ---------------------------------------------

ALTER TABLE "buddy"."BuddyFilter"
  ADD COLUMN IF NOT EXISTS "womenOnly" BOOLEAN NOT NULL DEFAULT false;

-- ---- Backfill ----------------------------------------------------------

-- Existing threat / underage reports become high severity, per the contract's
-- reason table. Runs after the column exists; re-running it is a no-op.
UPDATE "buddy"."Report" SET "severity" = 'high'
  WHERE "reason" IN ('threat', 'underage') AND "severity" <> 'high';
