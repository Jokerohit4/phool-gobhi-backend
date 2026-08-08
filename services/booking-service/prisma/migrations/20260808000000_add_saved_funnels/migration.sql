-- Hand-authored migration (same caveat as every prior migration in this
-- service: no shadow DB was available to run `prisma migrate dev`;
-- reconcile against the actual dev/prod DB before applying).
--
-- Brand-new table: persists admin-defined custom funnels (the /analytics
-- User Journey tab). steps is [{ event, filters? }, ...] in required order —
-- queried against analytics_events (a separate DB/pool, see
-- analyticsQueryService.js) at view time, never joined against this table.
CREATE TABLE "booking"."SavedFunnel" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedFunnel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedFunnel_name_key" ON "booking"."SavedFunnel"("name");
