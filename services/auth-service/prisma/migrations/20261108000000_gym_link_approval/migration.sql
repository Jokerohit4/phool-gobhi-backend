-- Hand-authored, additive migration: gym-side approval of self-declared links.
-- No DATABASE_URL/shadow DB is available here to run `prisma migrate dev`, so
-- reconcile against dev/prod before applying — same caveat as the preceding
-- migrations.
--
-- Two new nullable columns, no constraint changes: safe to apply online.
-- lock_timeout bounds how long the ALTERs wait for a table lock.

SET lock_timeout = '3s';

ALTER TABLE "auth"."GymLink" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "auth"."GymLink" ADD COLUMN IF NOT EXISTS "approvedByPartnerId" INTEGER;

-- A self link that already had a verified check-in is a confirmed membership,
-- so it must not reappear in the gym's pending queue. Unverified self links are
-- deliberately left pending: nobody at the gym has confirmed them yet.
UPDATE "auth"."GymLink"
   SET "approvedAt" = "firstVerifiedCheckinAt"
 WHERE "source" = 'self'
   AND "firstVerifiedCheckinAt" IS NOT NULL
   AND "approvedAt" IS NULL;
