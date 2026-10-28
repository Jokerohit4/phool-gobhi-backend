-- Workout track kept while a user is on a wellbeing plan, so switching
-- persona to wellness and back restores it (journeyService.switchJourneyTrack).
ALTER TABLE "health"."JourneyProgress"
ADD COLUMN "workoutSnapshot" JSONB;
