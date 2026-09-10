-- FR-23: one logical save, one session. A queued log replayed after a
-- reconnect finds the row it already created instead of duplicating it.
ALTER TABLE "health"."WorkoutSession" ADD COLUMN "clientRef" TEXT;
CREATE UNIQUE INDEX "WorkoutSession_clientRef_key" ON "health"."WorkoutSession"("clientRef");

-- FR-09: which classes of health data the consent grant covers. Only
-- `logs` is actionable today; a scope is added when the surface needing it
-- ships (see the model comment).
ALTER TABLE "health"."HealthConsent" ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY['logs']::TEXT[];

-- FR-08: nudge suppression, and the send log the frequency guards read.
-- Without a record of what went out there is no way to enforce "max 3 a
-- week" or "never two within 24 hours".
CREATE TYPE "health"."NudgeType" AS ENUM ('log', 'comeback');

CREATE TABLE "health"."NudgeOptOut" (
    "userId" INTEGER NOT NULL,
    "type" "health"."NudgeType" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NudgeOptOut_pkey" PRIMARY KEY ("userId","type")
);

CREATE TABLE "health"."NudgeLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "health"."NudgeType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NudgeLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NudgeLog_userId_sentAt_idx" ON "health"."NudgeLog"("userId", "sentAt");

-- Health+ FR-04 / Tech section 8: records the ACTOR, never the data. An
-- audit trail that copies the sensitive rows it audits doubles the exposure
-- it exists to control.
CREATE TABLE "health"."HealthDataAuditLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "actorId" INTEGER,
    "action" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthDataAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HealthDataAuditLog_userId_at_idx" ON "health"."HealthDataAuditLog"("userId", "at");
