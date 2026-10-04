-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Feature-flag audit trail (2026-10-04). Purely additive, so this is safe to
-- apply ahead of the code that writes to it: nothing reads the table until
-- updateAppConfigAdmin starts recording, and an empty table is the correct
-- starting state for a table whose first row is the first change after this
-- migration.
--
-- Why: the live flag values are a JSON blob inside "auth"."AppVersionSetting"."config".
-- That answers "what is it now" and never "what did it used to be". For a
-- kill-switch that decides whether a feature collects personal data — health
-- vault report upload, workout tracking, food-photo recognition — the question
-- that has to be answerable after an incident is "who switched this on, when,
-- and from what".
--
-- "changedFlags" is denormalised so that question is a WHERE clause rather than
-- a JSON diff over before/after that no index could serve. "before" is nullable
-- because the first write after this migration can follow a config blob that
-- predates it.

CREATE TABLE IF NOT EXISTS "auth"."AppConfigHistory" (
    "id" SERIAL NOT NULL,
    "changedFlags" TEXT[] NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "note" TEXT,
    "changedBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppConfigHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppConfigHistory_createdAt_idx"
  ON "auth"."AppConfigHistory"("createdAt");

CREATE INDEX IF NOT EXISTS "AppConfigHistory_changedBy_createdAt_idx"
  ON "auth"."AppConfigHistory"("changedBy", "createdAt");

-- Convenience index for the question this table exists to answer: "what has
-- happened to THIS flag?". A GIN index over the text array, so the lookup does
-- not degrade into a sequential scan once the table outgrows a few hundred rows.
CREATE INDEX IF NOT EXISTS "AppConfigHistory_changedFlags_idx"
  ON "auth"."AppConfigHistory" USING GIN ("changedFlags");
