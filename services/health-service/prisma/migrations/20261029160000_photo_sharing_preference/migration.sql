CREATE TABLE "health"."FoodPhotoSharingPreference" (
  "userId" INTEGER NOT NULL PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL,
  "consentVersion" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "health"."FoodPhotoContribution" ADD COLUMN "sourcePhotoPath" TEXT;
CREATE UNIQUE INDEX "FoodPhotoContribution_userId_sourcePhotoPath_key" ON "health"."FoodPhotoContribution"("userId", "sourcePhotoPath");
