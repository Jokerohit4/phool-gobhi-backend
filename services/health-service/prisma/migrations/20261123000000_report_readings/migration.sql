ALTER TABLE "health"."HealthReport"
    ADD COLUMN "proposedReadings" JSONB,
    ADD COLUMN "confirmedReadings" JSONB;
