-- Fitness+ Wave 1 (see phool-gobhi-fitness-plus-BRD.html):
--   FR-12 body measurement log (user-entered weight/body-fat/photo)
--   FR-15 suggestion feedback loop (impression row per shown suggestion)
CREATE TYPE "health"."SuggestionVote" AS ENUM ('up', 'down', 'skip', 'done');

CREATE TABLE "health"."Measurement" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "localDate" TEXT NOT NULL,
    "weightKg" DECIMAL(5,2),
    "bodyFatPct" DECIMAL(4,1),
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Measurement_pkey" PRIMARY KEY ("id")
);

-- One row per user-day: re-entering today's weight corrects it rather than
-- stacking a duplicate (the 2-tap entry flow assumes this).
CREATE UNIQUE INDEX "Measurement_userId_localDate_key" ON "health"."Measurement"("userId", "localDate");
CREATE INDEX "Measurement_userId_localDate_idx" ON "health"."Measurement"("userId", "localDate");

CREATE TABLE "health"."SuggestionFeedback" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "suggestionKey" TEXT NOT NULL,
    "reasoning" JSONB,
    "vote" "health"."SuggestionVote",
    "shownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "votedAt" TIMESTAMP(3),

    CONSTRAINT "SuggestionFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SuggestionFeedback_userId_shownAt_idx" ON "health"."SuggestionFeedback"("userId", "shownAt");
