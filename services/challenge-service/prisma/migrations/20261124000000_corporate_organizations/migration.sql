-- Corporate wellness: company profiles, private membership, teams and
-- time-boxed leaderboards. Additive only.
DO $$ BEGIN
  CREATE TYPE "challenge"."OrgStatus" AS ENUM ('active', 'expired', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "challenge"."OrgMemberStatus" AS ENUM ('invited', 'active', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "challenge"."OrgLeaderboardStatus" AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "challenge"."OrgLeaderboardScoring" AS ENUM ('active_days', 'workout_days', 'steps');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "challenge"."Organization" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "challenge"."OrgStatus" NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "contactName" TEXT,
    "contactEmail" TEXT,
    "notes" TEXT,
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_slug_key" ON "challenge"."Organization"("slug");
CREATE INDEX IF NOT EXISTS "Organization_status_expiresAt_idx" ON "challenge"."Organization"("status", "expiresAt");

CREATE TABLE IF NOT EXISTS "challenge"."OrganizationTeam" (
    "id" SERIAL NOT NULL,
    "orgId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationTeam_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationTeam_orgId_name_key" ON "challenge"."OrganizationTeam"("orgId", "name");

CREATE TABLE IF NOT EXISTS "challenge"."OrganizationMember" (
    "id" SERIAL NOT NULL,
    "orgId" INTEGER NOT NULL,
    "userId" INTEGER,
    "phone" TEXT NOT NULL,
    "displayName" TEXT,
    "teamId" INTEGER,
    "status" "challenge"."OrgMemberStatus" NOT NULL DEFAULT 'invited',
    "addedBy" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationMember_orgId_phone_key" ON "challenge"."OrganizationMember"("orgId", "phone");
CREATE INDEX IF NOT EXISTS "OrganizationMember_userId_status_idx" ON "challenge"."OrganizationMember"("userId", "status");
CREATE INDEX IF NOT EXISTS "OrganizationMember_phone_status_idx" ON "challenge"."OrganizationMember"("phone", "status");

CREATE TABLE IF NOT EXISTS "challenge"."OrgLeaderboard" (
    "id" SERIAL NOT NULL,
    "orgId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scoring" "challenge"."OrgLeaderboardScoring" NOT NULL DEFAULT 'active_days',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "status" "challenge"."OrgLeaderboardStatus" NOT NULL DEFAULT 'active',
    "showTeams" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgLeaderboard_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OrgLeaderboard_orgId_status_idx" ON "challenge"."OrgLeaderboard"("orgId", "status");

DO $$ BEGIN
  ALTER TABLE "challenge"."OrganizationTeam" ADD CONSTRAINT "OrganizationTeam_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "challenge"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "challenge"."OrganizationMember" ADD CONSTRAINT "OrganizationMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "challenge"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "challenge"."OrganizationMember" ADD CONSTRAINT "OrganizationMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "challenge"."OrganizationTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "challenge"."OrgLeaderboard" ADD CONSTRAINT "OrgLeaderboard_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "challenge"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
