-- Run and verify this backfill BEFORE deploying the removal of the recap/goal
-- startedAt fallback (B0.4 follow-up). Existing localDate values are authoritative.
-- Prisma timestamps are UTC instants stored as timestamp without time zone.
UPDATE "health"."WorkoutSession"
SET "localDate" = to_char(("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
WHERE "localDate" IS NULL;
