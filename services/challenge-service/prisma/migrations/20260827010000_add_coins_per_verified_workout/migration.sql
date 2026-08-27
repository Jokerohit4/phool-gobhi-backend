-- Health & Activity gamified layer: a workout logged in health-service
-- earns coins only when it coincides with a verified AttendanceEventLog the
-- same day (see health-service's implementation plan, "Gamified layer"
-- section, and this service's new POST /internal/workout-credit route).
ALTER TABLE "challenge"."CoinEconomyConfig" ADD COLUMN "coinsPerVerifiedWorkout" INTEGER NOT NULL DEFAULT 15;
