-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Lets a GymImage row represent a video instead of a photo. Existing rows
-- default to 'image' (they always were photos); new video uploads set it
-- explicitly. See the schema comment on GymImage.mediaType for why this is
-- a plain string, not a Postgres enum.

ALTER TABLE "gym"."GymImage" ADD COLUMN IF NOT EXISTS "mediaType" TEXT NOT NULL DEFAULT 'image';
