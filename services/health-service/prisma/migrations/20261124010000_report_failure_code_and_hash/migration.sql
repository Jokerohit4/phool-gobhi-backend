-- Why a report failed, and a hash of the uploaded file for same-user dedupe.
-- Both nullable and unindexed on their own: existing rows keep working untouched.
ALTER TABLE "health"."HealthReport"
    ADD COLUMN "failureCode" TEXT,
    ADD COLUMN "fileSha256" TEXT;

CREATE INDEX "HealthReport_userId_fileSha256_idx" ON "health"."HealthReport"("userId", "fileSha256");
