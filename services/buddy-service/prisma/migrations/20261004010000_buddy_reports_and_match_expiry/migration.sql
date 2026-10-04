-- Reports + match expiry (buddy-service moderation, 2026-10-04).
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

-- ---- Match expiry ------------------------------------------------------

-- `expired` is distinct from `unmatched`: unmatched means a person ended it,
-- expired means nobody spoke for 30 days. Keeping them apart matters because
-- they mean different things to the two people involved and to support.
ALTER TYPE "buddy"."MatchStatus" ADD VALUE IF NOT EXISTS 'expired';

-- ADD COLUMN with a DEFAULT is non-blocking in Postgres 11+, and the default
-- is what new rows get. Existing rows are corrected immediately below.
ALTER TABLE "buddy"."Match"
  ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill from real data rather than leaving everything at NOW().
--
-- The column just landed, so every existing row reads CURRENT_TIMESTAMP and
-- every pre-existing match would be treated as brand new — silently un-expirable
-- for 30 days, i.e. the feature would look deployed and do nothing on exactly
-- the rows that need it. The true value is "the later of when you matched and
-- when the last message was sent", which is recoverable from ChatMessage, so
-- recover it instead of guessing.
UPDATE "buddy"."Match" m
SET "lastActivityAt" = GREATEST(
  m."matchedAt",
  COALESCE(
    (SELECT MAX(c."createdAt") FROM "buddy"."ChatMessage" c WHERE c."matchId" = m.id),
    m."matchedAt"
  )
);

-- Supports the lazy-expiry read in getMatches / assertActiveParticipant.
CREATE INDEX IF NOT EXISTS "Match_status_lastActivityAt_idx"
  ON "buddy"."Match"("status", "lastActivityAt");

-- ---- Reports -----------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "buddy"."ReportReason" AS ENUM (
    'harassment', 'inappropriate_content', 'impersonation', 'spam',
    'underage', 'scam', 'threat', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "buddy"."ReportStatus" AS ENUM ('open', 'dismissed', 'actioned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "buddy"."Report" (
  "id"              SERIAL PRIMARY KEY,
  -- Nullable on purpose: erasureService nulls this for a user who deletes their
  -- account, keeping the safety record while dropping the pointer to them.
  "reportedUserId"  INTEGER,
  "reporterId"      INTEGER      NOT NULL,
  "reason"          "buddy"."ReportReason" NOT NULL,
  "details"         VARCHAR(1000),
  "status"          "buddy"."ReportStatus" NOT NULL DEFAULT 'open',
  "reviewedBy"      INTEGER,
  "reviewedAt"      TIMESTAMP(3),
  "resolutionNote"  VARCHAR(500),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Triage queue: "open reports, newest first" is the only query that matters.
CREATE INDEX IF NOT EXISTS "Report_status_createdAt_idx"
  ON "buddy"."Report"("status", "createdAt");

-- "How many reports has this person ever had?" — the question that decides
-- whether one more report tips into action.
CREATE INDEX IF NOT EXISTS "Report_reportedUserId_idx"
  ON "buddy"."Report"("reportedUserId");

-- One report per reporter per subject. Also the anti-spam guard: it is what
-- turns a repeat report into a 409 instead of a second queue row.
--
-- Deliberately NOT deferrable/partial on reportedUserId IS NOT NULL: a
-- deferred unique index would let an erased (null-pinned) report coexist with
-- a fresh one about the same person, which is exactly the duplicate we are
-- trying to prevent. reporterId + reportedUserId is already unique per pair,
-- and NULL rows never collide with each other, so the orphaned reports left
-- behind by erasure do not violate this.
CREATE UNIQUE INDEX IF NOT EXISTS "Report_reporterId_reportedUserId_key"
  ON "buddy"."Report"("reporterId", "reportedUserId");
