-- Baseline migration — buddy-service had no prisma/migrations/ history at all
-- (schema was applied via `db push` up to now). Generated via
-- `prisma migrate diff --from-empty --to-schema-datamodel` against the
-- current schema.prisma, so this SQL reflects the schema as it exists today.
--
-- The real dev/prod DB already has these tables (from db push) — do NOT run
-- this migration for real against them, or every CREATE TABLE will fail with
-- "already exists". Instead, baseline it:
--   npx prisma migrate resolve --applied 20260724010001_buddy_baseline
-- run once per environment (dev, then prod) so Prisma's _prisma_migrations
-- table records this as already-applied, and every future schema change to
-- this service can go through normal `prisma migrate deploy`. Only a
-- genuinely fresh/empty DB (e.g. a new environment stood up from scratch)
-- should actually execute this SQL.
--
-- NOTE: this folder was originally named 20260724010000_baseline, identical
-- to gym-service's own baseline migration. All services in this project
-- share ONE physical Postgres database (schema-per-service, not
-- database-per-service — see docker-compose/CLAUDE.md), and Prisma's
-- _prisma_migrations bookkeeping table is NOT schema-scoped — it's one
-- global table for the whole database, keyed by migration_name alone. Two
-- services using the same folder name collide: resolving gym-service's
-- baseline first made buddy-service's `migrate status` report "up to date"
-- for a migration that had never actually been recorded for it. Renamed to
-- a distinct, service-prefixed name to get its own row. Any future
-- migration added to any service here should use a name unlikely to collide
-- with another service's (a generic name like "baseline" or "init" is the
-- risky case — a descriptive name almost never collides).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "buddy";

-- CreateEnum
CREATE TYPE "buddy"."Gender" AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "buddy"."FitnessGoal" AS ENUM ('weight_loss', 'muscle_gain', 'general_fitness', 'flexibility_yoga', 'sports_training', 'rehabilitation');

-- CreateEnum
CREATE TYPE "buddy"."SwipeAction" AS ENUM ('like', 'pass');

-- CreateEnum
CREATE TYPE "buddy"."MatchStatus" AS ENUM ('active', 'unmatched');

-- CreateTable
CREATE TABLE "buddy"."BuddyProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "bio" VARCHAR(500),
    "socialMediaUrl" VARCHAR(255),
    "gender" "buddy"."Gender",
    "dateOfBirth" DATE,
    "fitnessGoals" "buddy"."FitnessGoal"[],
    "lastSyncedAt" TIMESTAMP(3),
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "isDiscoverable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuddyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buddy"."BuddyPhoto" (
    "id" SERIAL NOT NULL,
    "buddyProfileId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buddy"."BuddyFilter" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "radiusKm" INTEGER NOT NULL DEFAULT 25,
    "minAge" INTEGER NOT NULL DEFAULT 18,
    "maxAge" INTEGER NOT NULL DEFAULT 60,
    "genders" "buddy"."Gender"[],
    "fitnessGoals" "buddy"."FitnessGoal"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuddyFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buddy"."Swipe" (
    "id" SERIAL NOT NULL,
    "swiperId" INTEGER NOT NULL,
    "swipeeId" INTEGER NOT NULL,
    "action" "buddy"."SwipeAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Swipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buddy"."Match" (
    "id" SERIAL NOT NULL,
    "userLowId" INTEGER NOT NULL,
    "userHighId" INTEGER NOT NULL,
    "status" "buddy"."MatchStatus" NOT NULL DEFAULT 'active',
    "unmatchedBy" INTEGER,
    "unmatchedAt" TIMESTAMP(3),
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buddy"."ChatMessage" (
    "id" SERIAL NOT NULL,
    "matchId" INTEGER NOT NULL,
    "senderId" INTEGER NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buddy"."BlockedUser" (
    "id" SERIAL NOT NULL,
    "blockerId" INTEGER NOT NULL,
    "blockedId" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuddyProfile_userId_key" ON "buddy"."BuddyProfile"("userId");

-- CreateIndex
CREATE INDEX "BuddyProfile_lat_lng_idx" ON "buddy"."BuddyProfile"("lat", "lng");

-- CreateIndex
CREATE INDEX "BuddyProfile_isDiscoverable_isActive_idx" ON "buddy"."BuddyProfile"("isDiscoverable", "isActive");

-- CreateIndex
CREATE INDEX "BuddyPhoto_buddyProfileId_order_idx" ON "buddy"."BuddyPhoto"("buddyProfileId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "BuddyFilter_userId_key" ON "buddy"."BuddyFilter"("userId");

-- CreateIndex
CREATE INDEX "Swipe_swipeeId_action_idx" ON "buddy"."Swipe"("swipeeId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "Swipe_swiperId_swipeeId_key" ON "buddy"."Swipe"("swiperId", "swipeeId");

-- CreateIndex
CREATE INDEX "Match_userLowId_idx" ON "buddy"."Match"("userLowId");

-- CreateIndex
CREATE INDEX "Match_userHighId_idx" ON "buddy"."Match"("userHighId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_userLowId_userHighId_key" ON "buddy"."Match"("userLowId", "userHighId");

-- CreateIndex
CREATE INDEX "ChatMessage_matchId_createdAt_idx" ON "buddy"."ChatMessage"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "BlockedUser_blockedId_idx" ON "buddy"."BlockedUser"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedUser_blockerId_blockedId_key" ON "buddy"."BlockedUser"("blockerId", "blockedId");

-- AddForeignKey
ALTER TABLE "buddy"."BuddyPhoto" ADD CONSTRAINT "BuddyPhoto_buddyProfileId_fkey" FOREIGN KEY ("buddyProfileId") REFERENCES "buddy"."BuddyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buddy"."BuddyFilter" ADD CONSTRAINT "BuddyFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "buddy"."BuddyProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buddy"."ChatMessage" ADD CONSTRAINT "ChatMessage_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "buddy"."Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

