CREATE TABLE "health"."FoodPhotoUsage" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stage" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "model" TEXT,
  "tokensIn" INTEGER,
  "tokensOut" INTEGER,
  "thinkingTokens" INTEGER,
  "totalTokens" INTEGER,
  "cachedTokens" INTEGER
);
CREATE INDEX "FoodPhotoUsage_userId_requestedAt_idx" ON "health"."FoodPhotoUsage"("userId", "requestedAt");
CREATE TABLE "health"."FoodPhotoRecognitionCache" (
  "key" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "proposal" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "FoodPhotoRecognitionCache_userId_idx" ON "health"."FoodPhotoRecognitionCache"("userId");
CREATE INDEX "FoodPhotoRecognitionCache_expiresAt_idx" ON "health"."FoodPhotoRecognitionCache"("expiresAt");
CREATE TABLE "health"."FoodPhotoContribution" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "path" TEXT NOT NULL,
  "consentVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "label" JSONB,
  "reviewer" TEXT,
  "reviewedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "FoodPhotoContribution_path_key" ON "health"."FoodPhotoContribution"("path");
CREATE INDEX "FoodPhotoContribution_userId_idx" ON "health"."FoodPhotoContribution"("userId");
CREATE INDEX "FoodPhotoContribution_expiresAt_idx" ON "health"."FoodPhotoContribution"("expiresAt");
