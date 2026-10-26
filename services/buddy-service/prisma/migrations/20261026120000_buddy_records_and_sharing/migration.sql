ALTER TABLE buddy."BuddyProfile"
ADD COLUMN "publicCode" VARCHAR(12) NOT NULL DEFAULT upper(substr(md5(random()::text || clock_timestamp()::text), 1, 12)),
ADD COLUMN "isShareable" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "BuddyProfile_publicCode_key" ON buddy."BuddyProfile"("publicCode");
CREATE TABLE buddy."BuddyPersonalRecord" (
  "id" SERIAL PRIMARY KEY, "buddyProfileId" INTEGER NOT NULL,
  "exerciseId" INTEGER NOT NULL, "exerciseName" VARCHAR(150) NOT NULL,
  "weight" DOUBLE PRECISION NOT NULL CHECK ("weight" > 0 AND "weight" <= 2000),
  "unit" VARCHAR(2) NOT NULL CHECK ("unit" IN ('kg','lb')),
  "reps" INTEGER NOT NULL CHECK ("reps" BETWEEN 1 AND 1000),
  "mediaUrl" TEXT, "mediaPublicId" TEXT, "mediaType" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BuddyPersonalRecord_buddyProfileId_fkey" FOREIGN KEY ("buddyProfileId") REFERENCES buddy."BuddyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BuddyPersonalRecord_buddyProfileId_createdAt_idx" ON buddy."BuddyPersonalRecord"("buddyProfileId", "createdAt");
CREATE TABLE buddy."BuddyFollow" (
  "followerId" INTEGER NOT NULL, "targetId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("followerId", "targetId"), CHECK ("followerId" <> "targetId"),
  CONSTRAINT "BuddyFollow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES buddy."BuddyProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BuddyFollow_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES buddy."BuddyProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BuddyFollow_targetId_idx" ON buddy."BuddyFollow"("targetId");
