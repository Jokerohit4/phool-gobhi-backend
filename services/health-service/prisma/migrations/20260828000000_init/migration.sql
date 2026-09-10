-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "health";

-- CreateEnum
CREATE TYPE "health"."Platform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "health"."MuscleGroup" AS ENUM ('chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'fullBody');

-- CreateEnum
CREATE TYPE "health"."Equipment" AS ENUM ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other');

-- CreateEnum
CREATE TYPE "health"."LoggingType" AS ENUM ('sets_reps_weight', 'duration', 'duration_distance');

-- CreateEnum
CREATE TYPE "health"."ExerciseRecordSource" AS ENUM ('manual', 'healthkit', 'health_connect');

-- CreateEnum
CREATE TYPE "health"."DailyActivitySource" AS ENUM ('healthkit', 'health_connect');

-- CreateTable
CREATE TABLE "health"."HealthConsent" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "policyVersion" TEXT NOT NULL,
    "platform" "health"."Platform" NOT NULL,

    CONSTRAINT "HealthConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."Exercise" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "muscleGroup" "health"."MuscleGroup" NOT NULL,
    "equipment" "health"."Equipment" NOT NULL,
    "loggingType" "health"."LoggingType" NOT NULL,
    "primaryMuscles" TEXT[],
    "secondaryMuscles" TEXT[],
    "demoImageUrl" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."ExerciseFormVideo" (
    "id" SERIAL NOT NULL,
    "exerciseId" INTEGER NOT NULL,
    "languageCode" TEXT NOT NULL,
    "youtubeVideoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "channelName" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExerciseFormVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."WorkoutTemplate" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkoutTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."TemplateExercise" (
    "id" SERIAL NOT NULL,
    "templateId" INTEGER NOT NULL,
    "exerciseId" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    "targetSets" INTEGER NOT NULL,
    "targetReps" INTEGER NOT NULL,
    "restSeconds" INTEGER,
    "supersetGroup" INTEGER,

    CONSTRAINT "TemplateExercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."WorkoutSession" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "templateId" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "coinsAwarded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WorkoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."SessionExercise" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "exerciseId" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    "supersetGroup" INTEGER,

    CONSTRAINT "SessionExercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."WorkoutSet" (
    "id" SERIAL NOT NULL,
    "sessionExerciseId" INTEGER NOT NULL,
    "setNumber" INTEGER NOT NULL,
    "weightKg" DECIMAL(6,2),
    "reps" INTEGER,
    "durationSeconds" INTEGER,
    "distanceMeters" DECIMAL(8,2),
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkoutSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."ExerciseRecord" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "source" "health"."ExerciseRecordSource" NOT NULL,
    "externalId" TEXT,
    "type" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "caloriesBurned" INTEGER,
    "distanceMeters" DECIMAL(8,2),
    "avgHeartRateBpm" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExerciseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health"."DailyActivityMetric" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "steps" INTEGER,
    "activeCalories" INTEGER,
    "distanceMeters" DECIMAL(8,2),
    "restingHeartRateBpm" INTEGER,
    "source" "health"."DailyActivitySource" NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyActivityMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HealthConsent_userId_key" ON "health"."HealthConsent"("userId");

-- CreateIndex
CREATE INDEX "Exercise_muscleGroup_idx" ON "health"."Exercise"("muscleGroup");

-- CreateIndex
CREATE INDEX "Exercise_createdByUserId_idx" ON "health"."Exercise"("createdByUserId");

-- CreateIndex
CREATE INDEX "ExerciseFormVideo_exerciseId_languageCode_idx" ON "health"."ExerciseFormVideo"("exerciseId", "languageCode");

-- CreateIndex
CREATE INDEX "WorkoutTemplate_userId_idx" ON "health"."WorkoutTemplate"("userId");

-- CreateIndex
CREATE INDEX "TemplateExercise_templateId_idx" ON "health"."TemplateExercise"("templateId");

-- CreateIndex
CREATE INDEX "WorkoutSession_userId_startedAt_idx" ON "health"."WorkoutSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "SessionExercise_sessionId_idx" ON "health"."SessionExercise"("sessionId");

-- CreateIndex
CREATE INDEX "SessionExercise_exerciseId_idx" ON "health"."SessionExercise"("exerciseId");

-- CreateIndex
CREATE INDEX "WorkoutSet_sessionExerciseId_idx" ON "health"."WorkoutSet"("sessionExerciseId");

-- CreateIndex
CREATE INDEX "ExerciseRecord_userId_startedAt_idx" ON "health"."ExerciseRecord"("userId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExerciseRecord_userId_source_externalId_key" ON "health"."ExerciseRecord"("userId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyActivityMetric_userId_date_key" ON "health"."DailyActivityMetric"("userId", "date");

-- AddForeignKey
ALTER TABLE "health"."ExerciseFormVideo" ADD CONSTRAINT "ExerciseFormVideo_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "health"."Exercise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."TemplateExercise" ADD CONSTRAINT "TemplateExercise_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "health"."WorkoutTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."TemplateExercise" ADD CONSTRAINT "TemplateExercise_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "health"."Exercise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."WorkoutSession" ADD CONSTRAINT "WorkoutSession_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "health"."WorkoutTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."SessionExercise" ADD CONSTRAINT "SessionExercise_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "health"."WorkoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."SessionExercise" ADD CONSTRAINT "SessionExercise_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "health"."Exercise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health"."WorkoutSet" ADD CONSTRAINT "WorkoutSet_sessionExerciseId_fkey" FOREIGN KEY ("sessionExerciseId") REFERENCES "health"."SessionExercise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

