CREATE TABLE "wallet"."CoachingSessionLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER,
    "note" VARCHAR(500),
    "loggedBy" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'logged',
    "confirmedAt" TIMESTAMP(3),
    "disputeReason" VARCHAR(500),
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "membershipOrderId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoachingSessionLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoachingSessionLog_kind_check" CHECK ("kind" IN ('trainer', 'nutritionist')),
    CONSTRAINT "CoachingSessionLog_mode_check" CHECK ("mode" IN ('online', 'in_person')),
    CONSTRAINT "CoachingSessionLog_duration_check" CHECK ("durationMinutes" > 0),
    CONSTRAINT "CoachingSessionLog_status_check" CHECK ("status" IN ('logged', 'confirmed', 'disputed', 'auto_confirmed')),
    CONSTRAINT "CoachingSessionLog_resolution_check" CHECK ("resolution" IN ('upheld', 'recredited')),
    CONSTRAINT "CoachingSessionLog_membershipOrderId_fkey" FOREIGN KEY ("membershipOrderId") REFERENCES "wallet"."CoachingOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CoachingSessionLog_idempotencyKey_key" ON "wallet"."CoachingSessionLog"("idempotencyKey");
CREATE INDEX "CoachingSessionLog_userId_createdAt_id_idx" ON "wallet"."CoachingSessionLog"("userId", "createdAt", "id");
CREATE INDEX "CoachingSessionLog_status_resolution_createdAt_id_idx" ON "wallet"."CoachingSessionLog"("status", "resolution", "createdAt", "id");
