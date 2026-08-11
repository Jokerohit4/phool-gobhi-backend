-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Background: BuddyProfile.socialMediaUrl was added to schema.prisma AFTER
-- the prod DB was built via `db push`, and buddy-service's baseline
-- migration was then recorded with `prisma migrate resolve --applied`
-- without ever executing its SQL (the baseline's header says as much — the
-- real DB already had the tables, minus this column). So prod's
-- _prisma_migrations claims the baseline ran, the schema.prisma and the
-- generated Prisma client both query socialMediaUrl, but the column never
-- exists in the database — GET /api/buddy/profile/me 500s on
-- prisma.buddyProfile.findUnique() as a result. This forward migration
-- closes that gap on `prisma migrate deploy`.

ALTER TABLE "buddy"."BuddyProfile" ADD COLUMN IF NOT EXISTS "socialMediaUrl" VARCHAR(255);
