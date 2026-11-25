CREATE TABLE "health"."GoalPlan" (
    "userId" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "startDate" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "schedule" JSONB NOT NULL,
    "completions" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GoalPlan_pkey" PRIMARY KEY ("userId")
);
