-- Health profile (gamified onboarding v2, 2026-10-01): the "get to know you"
-- answers, their consent row, and medication reminders. See schema.prisma for
-- why each lives where it does. Additive only; no backfill — nobody is treated
-- as having answered or consented to anything they never saw.
CREATE TABLE IF NOT EXISTS "health"."HealthProfile" (
    "userId" INTEGER NOT NULL,
    "allergyStatus" TEXT,
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weightDeclined" BOOLEAN NOT NULL DEFAULT false,
    "heightDeclined" BOOLEAN NOT NULL DEFAULT false,
    "drinking" TEXT,
    "smoking" TEXT,
    "greens" TEXT,
    "otherSubstances" TEXT,
    "broughtHere" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mealsPerDay" INTEGER,
    "followsDiet" BOOLEAN,
    "dietType" TEXT,
    "whoCooks" TEXT,
    "occupation" TEXT,
    "workingHours" TEXT,
    "healthSpend" TEXT,
    "wearsSpectacles" BOOLEAN,
    "spectaclesType" TEXT,
    "hometown" TEXT,
    "medicationsStatus" TEXT,
    "coinKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "basicsAnsweredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthProfile_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."HealthProfileConsent" (
    "userId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthProfileConsent_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."MedicationReminder" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "times" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicationReminder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MedicationReminder_userId_idx" ON "health"."MedicationReminder"("userId");
