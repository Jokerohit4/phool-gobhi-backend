-- Hand-authored, additive migration: archive an account instead of deleting it.
-- Two nullable columns on User, no constraint changes: safe to apply online.
-- Reconcile against dev/prod before applying, same caveat as the preceding
-- hand-authored migrations (no shadow DB here to run `prisma migrate dev`).
--
-- archivedAt:   when the user closed their account. Null for every live user.
-- archivedData: the identifying fields (name, phone, email, photo, push token,
--               referral code) as they were, moved out of the live columns so the
--               number and email are free for a brand-new account while the data
--               itself is retained. Everything else on the row is left as it was.

SET lock_timeout = '3s';

ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "archivedData" JSONB;
