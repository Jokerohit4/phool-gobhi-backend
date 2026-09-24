-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- GPS run tracker (run-tracker-spec.html, 2026-09-24). Purely additive: a
-- new enum value on ExerciseRecordSource and a new RunTrack table 1:1 with
-- ExerciseRecord. Applying this changes nothing for anyone until a user has
-- both the healthMetrics AND runTracker flags on — the tables stay empty.

ALTER TYPE "health"."ExerciseRecordSource" ADD VALUE IF NOT EXISTS 'gps_tracker';

CREATE TABLE IF NOT EXISTS "health"."RunTrack" (
    "id"               SERIAL NOT NULL,
    "exerciseRecordId" INTEGER NOT NULL,
    "polyline"         TEXT NOT NULL,
    "thumbPolyline"    TEXT NOT NULL,
    "splits"           JSONB NOT NULL,
    "movingSeconds"    INTEGER NOT NULL,
    "elapsedSeconds"   INTEGER NOT NULL,
    "avgPaceSecPerKm"  INTEGER,
    "bestKmSeconds"    INTEGER,
    "pauseCount"       INTEGER NOT NULL DEFAULT 0,
    "pointCount"       INTEGER NOT NULL,
    "hadGap"           BOOLEAN NOT NULL DEFAULT false,
    "weightKgUsed"     DECIMAL(5,1),
    "appVersion"       TEXT,
    "platform"         "health"."Platform",
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunTrack_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "health"."RunTrack"
    ADD CONSTRAINT "RunTrack_exerciseRecordId_fkey"
    FOREIGN KEY ("exerciseRecordId") REFERENCES "health"."ExerciseRecord"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "RunTrack_exerciseRecordId_key"
  ON "health"."RunTrack"("exerciseRecordId");

-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside the same transaction as
-- a statement that uses the new value, and Postgres will also refuse to run
-- it inside ANY multi-statement transaction block in some versions. If this
-- file is applied as one transaction and fails on the ALTER TYPE line, run
-- that single statement first, commit, then apply the rest of this file.
