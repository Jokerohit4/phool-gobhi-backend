-- FR-04. The home ring previously compared every user to a hardcoded 5
-- sessions/week while their stated onboarding intent went unread; this is
-- the per-user target it should have been measured against.
--
-- setByUser separates an explicit choice from a value derived off
-- auth-service's weeklyFrequencyIntent: the derived one may be re-derived
-- if that intent changes, the explicit one never is.
CREATE TABLE "health"."WeeklyGoal" (
    "userId" INTEGER NOT NULL,
    "sessionsPerWeek" INTEGER NOT NULL,
    "setByUser" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyGoal_pkey" PRIMARY KEY ("userId")
);
