-- Align the Fitness+ measurement table with Health+ Phase 1 (PG-HEALTH-001
-- FR-01 "manual biometric entry: weight, resting HR, sleep, steps, stress,
-- HRV" on one per-metric schema, wearable-ready) instead of shipping a
-- fitness-only weight/body-fat table that Health+ would have to duplicate.
--
-- Safe as a straight drop-and-recreate: this feature has never launched
-- (healthMetrics flag is off in every environment), so Measurement holds no
-- production rows. Doing this now is free; doing it after Health+ Phase 1
-- starts would mean a migration plus two competing tables.
DROP TABLE IF EXISTS "health"."Measurement";

CREATE TYPE "health"."BiometricMetric" AS ENUM ('weight', 'body_fat', 'resting_hr', 'sleep_minutes', 'steps', 'hrv', 'stress');
CREATE TYPE "health"."BiometricSource" AS ENUM ('manual', 'healthkit', 'health_connect');

CREATE TABLE "health"."BiometricEntry" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "metric" "health"."BiometricMetric" NOT NULL,
    "value" DECIMAL(8,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "source" "health"."BiometricSource" NOT NULL DEFAULT 'manual',
    "localDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BiometricEntry_pkey" PRIMARY KEY ("id")
);

-- Day-grain key: re-entering today's weight corrects today, and a future
-- wearable sync upserts the same row instead of flooding the series.
CREATE UNIQUE INDEX "BiometricEntry_userId_metric_localDate_key" ON "health"."BiometricEntry"("userId", "metric", "localDate");
CREATE INDEX "BiometricEntry_userId_metric_localDate_idx" ON "health"."BiometricEntry"("userId", "metric", "localDate");

-- Weight belongs to the biometric series, not a stale setup copy on the
-- personalisation profile.
ALTER TABLE "health"."PersonalisationProfile" DROP COLUMN IF EXISTS "setupWeightKg";
