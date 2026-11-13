-- The adjustable plan behind the app's "Your plan" screen: the calorie
-- budget, the step target and the sleep window, as the user left them.
--
-- Three numbers and no more. Macros are derived from these plus
-- NutritionTarget's inputs at read time (never stored - a stored copy is a
-- second number that can disagree with the first), and sessionsPerWeek lives
-- in WeeklyGoal, which the home ring already reads. One number, one row.
CREATE TABLE "health"."Prescription" (
    "userId" INTEGER NOT NULL,
    "kcal" INTEGER NOT NULL,
    "stepsPerDay" INTEGER NOT NULL,
    "sleepMinutes" INTEGER NOT NULL,
    "rulesVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("userId")
);
