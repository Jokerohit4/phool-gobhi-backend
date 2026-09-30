-- Home setup on PersonalisationProfile (onboarding audit P2, 2026-10-01).
--
-- Asked once, at a home-track user's first "Start workout", never at signup:
-- what they train with and how much room they have. Read by the routine list
-- (fit badge + ordering), the suggestion engine and the coach.
--
-- homeEquipment is TEXT[] validated in the app layer against a fixed set
-- (services/homeSetup.js), the same pattern injuryZones already uses, so a new
-- option needs no enum migration. homeSetupAt records THAT the sheet was
-- answered: "I have no equipment" is an answer, and without it the app could
-- not tell that from "never asked".
--
-- No backfill: nobody has answered this yet, and null/[] already mean
-- "unknown", which every reader treats as "don't re-rank".
ALTER TABLE "health"."PersonalisationProfile"
  ADD COLUMN IF NOT EXISTS "homeEquipment" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "trainingSpace" TEXT,
  ADD COLUMN IF NOT EXISTS "homeSetupAt" TIMESTAMP(3);
