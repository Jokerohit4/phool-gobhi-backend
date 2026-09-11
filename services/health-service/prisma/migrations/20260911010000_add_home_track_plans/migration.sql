-- Home track (docs/../sprint2/PG-HUNT-001 H-19/H-21/H-22): shared system
-- routines, a free multi-week plan, and which track a user trains on.
-- Also fixes a pre-existing bug: setupWeightKg was read and written by
-- personalisationService/personalisationController but the column never
-- existed on this table.

-- CreateEnum
CREATE TYPE "health"."TrainingLocation" AS ENUM ('gym', 'home', 'both');

-- CreateEnum
CREATE TYPE "health"."TemplateLevel" AS ENUM ('beginner', 'intermediate');

-- AlterTable
ALTER TABLE "health"."PersonalisationProfile"
  ADD COLUMN "setupWeightKg" DECIMAL(8,2),
  ADD COLUMN "trainingLocation" "health"."TrainingLocation";

-- AlterTable
-- userId becomes nullable so a system template (owned by nobody, visible to
-- everybody) fits the same table as a user's own templates.
ALTER TABLE "health"."WorkoutTemplate"
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "estMinutes" INTEGER,
  ADD COLUMN "level" "health"."TemplateLevel";

-- CreateIndex
CREATE INDEX "WorkoutTemplate_isSystem_idx" ON "health"."WorkoutTemplate"("isSystem");

-- AlterTable
-- targetReps becomes nullable and gains a duration sibling: a duration-type
-- exercise (plank, wall sit) has no meaningful rep count, and until now
-- every TemplateExercise had to fake one. WorkoutSet already has this exact
-- reps/durationSeconds split for the real logged values.
ALTER TABLE "health"."TemplateExercise"
  ALTER COLUMN "targetReps" DROP NOT NULL,
  ADD COLUMN "targetDurationSeconds" INTEGER;

-- CreateTable
CREATE TABLE "health"."WorkoutPlan" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "weeks" INTEGER NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkoutPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkoutPlan_key_key" ON "health"."WorkoutPlan"("key");

-- CreateTable
CREATE TABLE "health"."WorkoutPlanDay" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "weekIndex" INTEGER NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "templateId" INTEGER,

    CONSTRAINT "WorkoutPlanDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkoutPlanDay_planId_weekIndex_dayIndex_key" ON "health"."WorkoutPlanDay"("planId", "weekIndex", "dayIndex");

-- CreateTable
CREATE TABLE "health"."UserActivePlan" (
    "userId" INTEGER NOT NULL,
    "planId" INTEGER NOT NULL,
    "startedOn" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserActivePlan_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "health"."WorkoutPlanDay" ADD CONSTRAINT "WorkoutPlanDay_planId_fkey" FOREIGN KEY ("planId") REFERENCES "health"."WorkoutPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."WorkoutPlanDay" ADD CONSTRAINT "WorkoutPlanDay_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "health"."WorkoutTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."UserActivePlan" ADD CONSTRAINT "UserActivePlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "health"."WorkoutPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
