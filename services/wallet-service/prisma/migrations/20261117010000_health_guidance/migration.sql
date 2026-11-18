-- CreateTable
CREATE TABLE "wallet"."CoachingMembership" (
    "userId" INTEGER NOT NULL,
    "planType" TEXT NOT NULL DEFAULT 'FREE',
    "planStatus" TEXT NOT NULL DEFAULT 'INACTIVE',
    "trialEndsAt" TIMESTAMP(3),
    "planEndsAt" TIMESTAMP(3),
    "purchasedAt" TIMESTAMP(3),
    "freeDelightSessionsRemaining" INTEGER NOT NULL DEFAULT 0,
    "labCreditsRemaining" INTEGER NOT NULL DEFAULT 0,
    "gymPassStatus" TEXT NOT NULL DEFAULT 'NOT_ISSUED',
    "hasExistingGym" BOOLEAN NOT NULL DEFAULT false,
    "activeOrderId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachingMembership_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "wallet"."CoachingOrder" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "product" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfilledAt" TIMESTAMP(3),
    "refundId" TEXT,
    "refundRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachingOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."CoachingAddonGrant" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL DEFAULT 4,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachingAddonGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."CoachingFulfillment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "completedBy" INTEGER,
    "notificationDeliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachingFulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoachingMembership_activeOrderId_key" ON "wallet"."CoachingMembership"("activeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CoachingOrder_orderId_key" ON "wallet"."CoachingOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CoachingOrder_paymentId_key" ON "wallet"."CoachingOrder"("paymentId");

-- CreateIndex
CREATE INDEX "CoachingOrder_userId_status_idx" ON "wallet"."CoachingOrder"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CoachingAddonGrant_orderId_key" ON "wallet"."CoachingAddonGrant"("orderId");

-- CreateIndex
CREATE INDEX "CoachingAddonGrant_userId_expiresAt_idx" ON "wallet"."CoachingAddonGrant"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoachingFulfillment_idempotencyKey_key" ON "wallet"."CoachingFulfillment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CoachingFulfillment_userId_createdAt_idx" ON "wallet"."CoachingFulfillment"("userId", "createdAt");

-- Preserve the earlier coaching pilot, without mixing its payments into wallets.
-- Unpaid pilot checkouts are cancelled; any late capture is reconciled to refund.
INSERT INTO "wallet"."CoachingOrder" ("userId", "product", "amountPaise", "orderId", "paymentId", "status", "fulfilledAt", "createdAt", "updatedAt")
SELECT "userId", "planType", ROUND("amount" * 100)::INTEGER, "orderId", "razorpayPaymentId",
  CASE WHEN "status" = 'SUCCESS' THEN 'SUCCESS' ELSE 'CANCELLED' END,
  CASE WHEN "status" = 'SUCCESS' THEN "updatedAt" ELSE NULL END, "createdAt", "updatedAt"
FROM "wallet"."RazorpayOrder"
WHERE "purpose" = 'coaching' AND "planType" IN ('MONTHLY_4499', 'QUARTERLY_11999', 'TRAINER_ADDON_1499')
ON CONFLICT ("orderId") DO NOTHING;

INSERT INTO "wallet"."CoachingMembership" ("userId", "planType", "planStatus", "trialEndsAt", "planEndsAt", "purchasedAt", "freeDelightSessionsRemaining", "labCreditsRemaining", "gymPassStatus", "hasExistingGym", "activeOrderId", "createdAt", "updatedAt")
SELECT s."userId", s."planType", s."planStatus", s."trialEndsAt",
  CASE WHEN s."planType" = 'FREE' THEN NULL ELSE COALESCE(s."trialEndsAt" - INTERVAL '72 hours', s."createdAt") + CASE WHEN s."planType" = 'QUARTERLY_11999' THEN INTERVAL '90 days' ELSE INTERVAL '30 days' END END,
  CASE WHEN s."planType" = 'FREE' THEN NULL ELSE COALESCE(s."trialEndsAt" - INTERVAL '72 hours', s."createdAt") END,
  LEAST(2, GREATEST(0, s."freeDelightSessionsRemaining")), LEAST(2, GREATEST(0, s."labCreditsRemaining")), s."gymPassStatus", s."hasExistingGym",
  (SELECT o."id" FROM "wallet"."CoachingOrder" o WHERE o."userId" = s."userId" AND o."product" = s."planType" AND o."status" = 'SUCCESS' ORDER BY o."createdAt" DESC LIMIT 1),
  s."createdAt", s."updatedAt"
FROM "wallet"."CoachingSubscription" s
ON CONFLICT ("userId") DO NOTHING;

-- The pilot did not record grant expiry. Preserve its balance with a one-time
-- 30-day migration grace; negative order IDs identify these legacy grants.
INSERT INTO "wallet"."CoachingAddonGrant" ("userId", "orderId", "remaining", "expiresAt")
SELECT "userId", -"userId", "addonTrainerSessionsRemaining", CURRENT_TIMESTAMP + INTERVAL '30 days'
FROM "wallet"."CoachingSubscription" WHERE "addonTrainerSessionsRemaining" > 0;

ALTER TABLE "wallet"."CoachingMembership"
  ADD CONSTRAINT "CoachingMembership_planType_check" CHECK ("planType" IN ('FREE', 'MONTHLY_4499', 'QUARTERLY_11999')),
  ADD CONSTRAINT "CoachingMembership_planStatus_check" CHECK ("planStatus" IN ('INACTIVE', 'TRIAL_72H', 'ACTIVE', 'REFUNDED', 'EXPIRED')),
  ADD CONSTRAINT "CoachingMembership_balances_check" CHECK ("freeDelightSessionsRemaining" BETWEEN 0 AND 2 AND "labCreditsRemaining" BETWEEN 0 AND 2);
ALTER TABLE "wallet"."CoachingAddonGrant" ADD CONSTRAINT "CoachingAddonGrant_balance_check" CHECK ("remaining" >= 0 AND ("remaining" <= 4 OR "orderId" < 0));
ALTER TABLE "wallet"."CoachingOrder" ADD CONSTRAINT "CoachingOrder_price_check" CHECK (
  ("product" = 'MONTHLY_4499' AND "amountPaise" = 449900) OR
  ("product" = 'QUARTERLY_11999' AND "amountPaise" = 1199900) OR
  ("product" = 'TRAINER_ADDON_1499' AND "amountPaise" = 149900));
CREATE UNIQUE INDEX "CoachingOrder_one_pending_product" ON "wallet"."CoachingOrder" ("userId", "product") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "CoachingOrder_one_pending_plan" ON "wallet"."CoachingOrder" ("userId") WHERE "status" = 'PENDING' AND "product" <> 'TRAINER_ADDON_1499';
