-- FR-25/26/27 (see phool-gobhi-fitness-plus-BRD.html), with one deliberate
-- departure from that doc's schema sketch: no cycleAware/pregnancyFlag/
-- postpartumFlag columns. The engine needs to know HOW to program, never
-- WHY, so only the derived ProgrammingMode is stored — the medical fact
-- behind it is mapped on-device and never transmitted. See the schema
-- comment on ProgrammingMode for the full reasoning.
CREATE TYPE "health"."ProgrammingMode" AS ENUM ('neutral', 'female_default', 'low_impact_recovery');
CREATE TYPE "health"."ExperienceLevel" AS ENUM ('none', 'lt_1_year', 'one_to_three_years', 'over_three_years');
CREATE TYPE "health"."EnergyPattern" AS ENUM ('morning', 'afternoon', 'evening');

CREATE TABLE "health"."PersonalisationProfile" (
    "userId" INTEGER NOT NULL,
    "heightCm" INTEGER,
    "setupWeightKg" DECIMAL(5,2),
    "experienceLevel" "health"."ExperienceLevel",
    "injuryZones" TEXT[],
    "energyPattern" "health"."EnergyPattern",
    "preferredRestDay" INTEGER,
    "programmingMode" "health"."ProgrammingMode" NOT NULL DEFAULT 'neutral',
    "consentAt" TIMESTAMP(3),
    "privacyVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalisationProfile_pkey" PRIMARY KEY ("userId")
);
