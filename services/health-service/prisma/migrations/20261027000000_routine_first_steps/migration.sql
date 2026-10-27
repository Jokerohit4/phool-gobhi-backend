CREATE TABLE "health"."RoutineJourneyState" (
 "userId" INTEGER PRIMARY KEY, "accountCreatedAt" TIMESTAMP(3) NOT NULL,
 "waterLoggedAt" TIMESTAMP(3), "workoutCompletedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "health"."RoutineWaterDay" (
 "userId" INTEGER NOT NULL, "localDate" TEXT NOT NULL, "targetMl" INTEGER NOT NULL,
 "rewardedLogs" INTEGER NOT NULL DEFAULT 0, "lastRewardAt" TIMESTAMP(3), PRIMARY KEY ("userId", "localDate")
);
CREATE TABLE "health"."RoutineRewardClaim" (
 "key" TEXT PRIMARY KEY, "userId" INTEGER NOT NULL, "amount" INTEGER NOT NULL,
 "description" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "paidAt" TIMESTAMP(3)
);
CREATE INDEX "RoutineRewardClaim_userId_paidAt_idx" ON "health"."RoutineRewardClaim"("userId", "paidAt");

ALTER TABLE "health"."WaterLog" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "WaterLog_clientRequestId_key" ON "health"."WaterLog"("clientRequestId");
