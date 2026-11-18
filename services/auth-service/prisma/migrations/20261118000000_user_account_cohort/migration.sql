-- Hand-authored, additive migration: segment users by who they are
-- (friends & family, generated, testing, unknown) for beta cohorts.
-- Reconcile against dev/prod before applying, same caveat as the preceding
-- hand-authored migrations (no shadow DB here to run `prisma migrate dev`).
--
-- NOT NULL DEFAULT 'UNKNOWN_USERS' is a metadata-only change on Postgres 11+
-- (constant default), so existing rows need no rewrite and no backfill: every
-- current account reads as UNKNOWN_USERS until staff classify it.

SET lock_timeout = '3s';

DO $$ BEGIN
  CREATE TYPE "auth"."AccountCohort" AS ENUM
    ('FRIENDS_AND_FAMILY', 'GENERATED_ACCOUNTS', 'TESTING_ACCOUNTS', 'UNKNOWN_USERS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "auth"."User"
  ADD COLUMN IF NOT EXISTS "accountCohort" "auth"."AccountCohort" NOT NULL DEFAULT 'UNKNOWN_USERS';

-- Plain (non-CONCURRENTLY) build: fine at current table size; Prisma migrations
-- run in a transaction so CONCURRENTLY is not an option here.
CREATE INDEX IF NOT EXISTS "User_accountCohort_idx" ON "auth"."User"("accountCohort");

-- Backfill: an account with an email but no phone number did not come through
-- phone OTP signup, so it is a testing account. Staff (role gobhi) are excluded:
-- they sign in with email/password or Google by design. Everything else is left as
-- UNKNOWN_USERS and classified by hand. Only touches rows still at the default,
-- so re-running never overwrites a hand-assigned cohort.
UPDATE "auth"."User"
SET "accountCohort" = 'TESTING_ACCOUNTS'
WHERE "accountCohort" = 'UNKNOWN_USERS'
  AND "role" <> 'gobhi'
  AND "email" IS NOT NULL AND btrim("email") <> ''
  AND ("phone" IS NULL OR btrim("phone") = '');
