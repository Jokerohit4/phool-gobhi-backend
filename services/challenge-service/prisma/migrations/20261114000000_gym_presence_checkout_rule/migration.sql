-- Who is inside a gym, and workout credits held until they check out by scan.
-- Additive only.
CREATE TABLE IF NOT EXISTS "challenge"."GymPresence" (
    "userId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "day" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GymPresence_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "challenge"."HeldWorkoutCredit" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "day" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "HeldWorkoutCredit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "HeldWorkoutCredit_userId_idempotencyKey_key" ON "challenge"."HeldWorkoutCredit"("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "HeldWorkoutCredit_userId_day_idx" ON "challenge"."HeldWorkoutCredit"("userId", "day");
