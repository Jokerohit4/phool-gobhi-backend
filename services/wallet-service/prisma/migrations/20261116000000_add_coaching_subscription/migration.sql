CREATE TABLE "wallet"."CoachingSubscription" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "userName" TEXT,
  "phone" TEXT,
  "planType" TEXT NOT NULL DEFAULT 'FREE',
  "planStatus" TEXT NOT NULL DEFAULT 'INACTIVE',
  "trialEndsAt" TIMESTAMP(3),
  "riskBucket" TEXT NOT NULL DEFAULT 'UNSET',
  "hasExistingGym" BOOLEAN NOT NULL DEFAULT false,
  "hasNutritionist" BOOLEAN NOT NULL DEFAULT false,
  "worksOut" BOOLEAN,
  "freeDelightSessionsRemaining" INTEGER NOT NULL DEFAULT 0,
  "addonTrainerSessionsRemaining" INTEGER NOT NULL DEFAULT 0,
  "labCreditsRemaining" INTEGER NOT NULL DEFAULT 0,
  "labBookingStatus" TEXT NOT NULL DEFAULT 'NOT_BOOKED',
  "gymPassStatus" TEXT NOT NULL DEFAULT 'NOT_ISSUED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoachingSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoachingSubscription_userId_key" ON "wallet"."CoachingSubscription"("userId");
CREATE INDEX "CoachingSubscription_planType_planStatus_idx" ON "wallet"."CoachingSubscription"("planType", "planStatus");
