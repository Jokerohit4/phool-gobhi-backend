SET lock_timeout = '3s';

CREATE TYPE "health"."WellnessMoodSlot" AS ENUM ('morning', 'night');

CREATE TABLE "health"."WellnessMoodCheckIn" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "localDate" TEXT NOT NULL,
    "slot" "health"."WellnessMoodSlot" NOT NULL,
    "mood" TEXT NOT NULL,
    "factors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "support" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WellnessMoodCheckIn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WellnessMoodCheckIn_userId_localDate_slot_key"
    ON "health"."WellnessMoodCheckIn"("userId", "localDate", "slot");

CREATE INDEX "WellnessMoodCheckIn_userId_localDate_idx"
    ON "health"."WellnessMoodCheckIn"("userId", "localDate");
