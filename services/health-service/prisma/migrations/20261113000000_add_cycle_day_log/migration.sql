-- Per-day cycle symptom log. See CycleDayLog in schema.prisma.
CREATE TABLE IF NOT EXISTS "health"."CycleDayLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "flow" TEXT,
    "mood" TEXT,
    "symptoms" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CycleDayLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CycleDayLog_userId_date_key"
  ON "health"."CycleDayLog"("userId", "date");
