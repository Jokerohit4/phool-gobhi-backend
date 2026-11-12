-- Entrances and exits, one row each, for the live occupancy view and the
-- check-out rule on workout coins. Additive only: no existing row changes.
CREATE TABLE IF NOT EXISTS "booking"."GymPresenceEvent" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "bookingId" INTEGER,
    "date" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GymPresenceEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GymPresenceEvent_gymId_at_idx" ON "booking"."GymPresenceEvent"("gymId", "at");
CREATE INDEX IF NOT EXISTS "GymPresenceEvent_gymId_date_idx" ON "booking"."GymPresenceEvent"("gymId", "date");
CREATE INDEX IF NOT EXISTS "GymPresenceEvent_customerId_gymId_date_at_idx" ON "booking"."GymPresenceEvent"("customerId", "gymId", "date", "at");
