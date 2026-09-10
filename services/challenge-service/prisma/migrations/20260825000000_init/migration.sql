-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "challenge";

-- CreateEnum
CREATE TYPE "challenge"."CoinLedgerEntryType" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "challenge"."CoinCatalogCategory" AS ENUM ('subscription_discount', 'priority_booking', 'buddy_unlock', 'brand_product');

-- CreateEnum
CREATE TYPE "challenge"."CoinRedemptionStatus" AS ENUM ('fulfilled', 'refunded');

-- CreateEnum
CREATE TYPE "challenge"."ChallengeCategory" AS ENUM ('gym_native', 'outside_gym_city', 'social');

-- CreateEnum
CREATE TYPE "challenge"."ChallengeType" AS ENUM ('off_peak_hunter', 'city_gym_circuit', 'poi_checkin_tour', 'landmark_hunt', 'city_marathon_series', 'buddy_squad', 'gym_date_night');

-- CreateEnum
CREATE TYPE "challenge"."VerificationMethod" AS ENUM ('booking_attendance', 'qr_scan', 'gps_geofence', 'photo_review', 'manual_admin');

-- CreateEnum
CREATE TYPE "challenge"."ChallengeStatus" AS ENUM ('draft', 'active', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "challenge"."EnrollmentStatus" AS ENUM ('active', 'completed', 'abandoned');

-- CreateEnum
CREATE TYPE "challenge"."RewardType" AS ENUM ('coins', 'physical_medal', 'leaderboard_recognition');

-- CreateEnum
CREATE TYPE "challenge"."SponsorType" AS ENUM ('gym', 'brand');

-- CreateEnum
CREATE TYPE "challenge"."SponsorStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "challenge"."TeamRole" AS ENUM ('leader', 'member');

-- CreateTable
CREATE TABLE "challenge"."CoinBalance" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoinBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."CoinLedgerEntry" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "challenge"."CoinLedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."AttendanceEventLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "attendedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."UserStreak" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastQualifiedWeekStart" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."UserStreakWeek" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "checkinCount" INTEGER NOT NULL DEFAULT 0,
    "qualified" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStreakWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."CoinEconomyConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "coinsPerCheckin" INTEGER NOT NULL DEFAULT 10,
    "weeklyTargetBonus" INTEGER NOT NULL DEFAULT 20,
    "milestones" JSONB NOT NULL DEFAULT '{"2":50,"4":150,"12":500}',
    "pairedStreakWeeklyBonus" INTEGER NOT NULL DEFAULT 15,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "CoinEconomyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."CoinCatalogItem" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "category" "challenge"."CoinCatalogCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "coinCost" INTEGER NOT NULL,
    "discountAmount" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoinCatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."CoinRedemption" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "catalogItemId" INTEGER NOT NULL,
    "coinCost" INTEGER NOT NULL,
    "status" "challenge"."CoinRedemptionStatus" NOT NULL DEFAULT 'fulfilled',
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoinRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."Sponsor" (
    "id" SERIAL NOT NULL,
    "type" "challenge"."SponsorType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "challenge"."SponsorStatus" NOT NULL DEFAULT 'active',
    "contactInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."ChallengeDefinition" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "type" "challenge"."ChallengeType" NOT NULL,
    "category" "challenge"."ChallengeCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "defaultVerificationMethod" "challenge"."VerificationMethod" NOT NULL,
    "requiresGeofenceWithQr" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallengeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."Challenge" (
    "id" SERIAL NOT NULL,
    "challengeDefinitionId" INTEGER NOT NULL,
    "city" TEXT NOT NULL,
    "status" "challenge"."ChallengeStatus" NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "targetCount" INTEGER NOT NULL,
    "rewardCoins" INTEGER NOT NULL,
    "offPeakWindows" JSONB,
    "sponsorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."SponsorMedalBudget" (
    "id" SERIAL NOT NULL,
    "sponsorId" INTEGER NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "totalMedals" INTEGER NOT NULL,
    "issuedMedals" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SponsorMedalBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."ChallengeEnrollment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "status" "challenge"."EnrollmentStatus" NOT NULL DEFAULT 'active',
    "progressCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ChallengeEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."ChallengeTeam" (
    "id" SERIAL NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."ChallengeTeamMember" (
    "id" SERIAL NOT NULL,
    "teamId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "challenge"."TeamRole" NOT NULL DEFAULT 'member',

    CONSTRAINT "ChallengeTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."ChallengeCheckpointSpot" (
    "id" SERIAL NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 75,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeCheckpointSpot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."ChallengeCheckpointVisit" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "checkpointSpotId" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeCheckpointVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."ChallengeWinner" (
    "id" SERIAL NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeWinner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."RewardIssuance" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "rewardType" "challenge"."RewardType" NOT NULL,
    "coinAmount" INTEGER,
    "medalSerial" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardIssuance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge"."PairedStreak" (
    "id" SERIAL NOT NULL,
    "matchId" INTEGER NOT NULL,
    "userAId" INTEGER NOT NULL,
    "userBId" INTEGER NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastQualifiedWeekStart" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PairedStreak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoinBalance_userId_key" ON "challenge"."CoinBalance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinLedgerEntry_idempotencyKey_key" ON "challenge"."CoinLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CoinLedgerEntry_userId_createdAt_idx" ON "challenge"."CoinLedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEventLog_bookingId_key" ON "challenge"."AttendanceEventLog"("bookingId");

-- CreateIndex
CREATE INDEX "AttendanceEventLog_userId_attendedAt_idx" ON "challenge"."AttendanceEventLog"("userId", "attendedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserStreak_userId_key" ON "challenge"."UserStreak"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserStreakWeek_userId_weekStart_key" ON "challenge"."UserStreakWeek"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "UserStreakWeek_userId_weekStart_idx" ON "challenge"."UserStreakWeek"("userId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "CoinCatalogItem_key_key" ON "challenge"."CoinCatalogItem"("key");

-- CreateIndex
CREATE UNIQUE INDEX "CoinRedemption_idempotencyKey_key" ON "challenge"."CoinRedemption"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CoinRedemption_userId_createdAt_idx" ON "challenge"."CoinRedemption"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeDefinition_key_key" ON "challenge"."ChallengeDefinition"("key");

-- CreateIndex
CREATE INDEX "Challenge_status_city_idx" ON "challenge"."Challenge"("status", "city");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeEnrollment_userId_challengeId_key" ON "challenge"."ChallengeEnrollment"("userId", "challengeId");

-- CreateIndex
CREATE INDEX "ChallengeEnrollment_challengeId_status_idx" ON "challenge"."ChallengeEnrollment"("challengeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeTeamMember_teamId_userId_key" ON "challenge"."ChallengeTeamMember"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeCheckpointSpot_code_key" ON "challenge"."ChallengeCheckpointSpot"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeCheckpointVisit_enrollmentId_checkpointSpotId_key" ON "challenge"."ChallengeCheckpointVisit"("enrollmentId", "checkpointSpotId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardIssuance_enrollmentId_key" ON "challenge"."RewardIssuance"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PairedStreak_matchId_key" ON "challenge"."PairedStreak"("matchId");

-- AddForeignKey
ALTER TABLE "challenge"."CoinRedemption" ADD CONSTRAINT "CoinRedemption_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "challenge"."CoinCatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."Challenge" ADD CONSTRAINT "Challenge_challengeDefinitionId_fkey" FOREIGN KEY ("challengeDefinitionId") REFERENCES "challenge"."ChallengeDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."Challenge" ADD CONSTRAINT "Challenge_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "challenge"."Sponsor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."SponsorMedalBudget" ADD CONSTRAINT "SponsorMedalBudget_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "challenge"."Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."SponsorMedalBudget" ADD CONSTRAINT "SponsorMedalBudget_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "challenge"."Challenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."ChallengeEnrollment" ADD CONSTRAINT "ChallengeEnrollment_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "challenge"."Challenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."ChallengeTeam" ADD CONSTRAINT "ChallengeTeam_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "challenge"."Challenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."ChallengeTeamMember" ADD CONSTRAINT "ChallengeTeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "challenge"."ChallengeTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."ChallengeCheckpointSpot" ADD CONSTRAINT "ChallengeCheckpointSpot_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "challenge"."Challenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."ChallengeCheckpointVisit" ADD CONSTRAINT "ChallengeCheckpointVisit_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "challenge"."ChallengeEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."ChallengeCheckpointVisit" ADD CONSTRAINT "ChallengeCheckpointVisit_checkpointSpotId_fkey" FOREIGN KEY ("checkpointSpotId") REFERENCES "challenge"."ChallengeCheckpointSpot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."ChallengeWinner" ADD CONSTRAINT "ChallengeWinner_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "challenge"."Challenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge"."RewardIssuance" ADD CONSTRAINT "RewardIssuance_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "challenge"."ChallengeEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
