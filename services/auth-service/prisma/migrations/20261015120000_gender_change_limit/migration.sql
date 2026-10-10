-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Gender-change limit (W5): a user may change their gender once. The first
-- real change (old gender set, new gender differs) records when and what, so
-- a second one can be rejected with GENDER_CHANGE_LIMIT. buddy-service copies
-- both into BuddyProfile to keep a man who became "female" out of women-only
-- decks. Both columns are nullable and additive, so auth and buddy can deploy
-- in either order.
SET lock_timeout = '3s';

ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "genderChangedAt" TIMESTAMP(3);
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "genderChangedTo" "auth"."Gender";
