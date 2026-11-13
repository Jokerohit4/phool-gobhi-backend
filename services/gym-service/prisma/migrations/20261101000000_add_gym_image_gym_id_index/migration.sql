-- Every gym read joins its images by gymId; GymImage had no index on it.
-- Index-only, no data change.
CREATE INDEX IF NOT EXISTS "GymImage_gymId_idx" ON "gym"."GymImage"("gymId");
