CREATE TABLE "auth"."ExploreReceiptEvent" (
  "eventId" UUID NOT NULL,
  "userId" INTEGER NOT NULL,
  "receiptId" TEXT,
  "claimId" TEXT,
  "event" TEXT NOT NULL,
  "properties" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "deliveredAt" TIMESTAMPTZ(3),
  CONSTRAINT "ExploreReceiptEvent_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "ExploreReceiptEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExploreReceiptEvent_outcome_check" CHECK (
    ("event" = 'explore_pickup_saved' AND "receiptId" IS NOT NULL AND "claimId" IS NULL) OR
    ("event" = 'explore_pickup_rejected' AND "receiptId" IS NULL AND "claimId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ExploreReceiptEvent_receiptId_key" ON "auth"."ExploreReceiptEvent"("receiptId");
CREATE UNIQUE INDEX "ExploreReceiptEvent_userId_claimId_key" ON "auth"."ExploreReceiptEvent"("userId", "claimId");
CREATE INDEX "ExploreReceiptEvent_deliveredAt_nextAttemptAt_idx" ON "auth"."ExploreReceiptEvent"("deliveredAt", "nextAttemptAt");
CREATE INDEX "ExploreReceiptEvent_userId_idx" ON "auth"."ExploreReceiptEvent"("userId");
