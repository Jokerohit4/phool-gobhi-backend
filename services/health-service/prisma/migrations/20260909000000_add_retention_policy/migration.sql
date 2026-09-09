-- DPDPA purpose limitation. Only purpose-limited telemetry is configurable:
-- the user's own record (sessions/biometrics/personalisation) is deleted with
-- the account rather than on a timer, and financial records in
-- wallet/booking-service are under statutory retention and never swept.
-- See services/retentionService.js for why those buckets must stay distinct.
CREATE TABLE "health"."RetentionPolicy" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "suggestionFeedbackDays" INTEGER NOT NULL DEFAULT 180,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id")
);
