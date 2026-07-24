-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`), same caveat as the preceding
-- migration ("20260717120000_wallet_decimal_and_indexes") — authored from
-- schema.prisma only, not verified against a live database. Reconcile
-- against the actual dev/prod DB before applying.

-- CreateEnum
CREATE TYPE "wallet"."SubscriptionStatus" AS ENUM ('active', 'cancelled');

-- AlterTable: RazorpayOrder gains a purpose discriminator + gym/plan refs so
-- subscription purchases can reuse the existing claim-then-credit flow.
ALTER TABLE "wallet"."RazorpayOrder"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'topup',
  ADD COLUMN "gymId" INTEGER,
  ADD COLUMN "planType" TEXT;

-- CreateTable
CREATE TABLE "wallet"."GymSubscription" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "planType" TEXT NOT NULL,
    "price" DECIMAL(19,2) NOT NULL,
    "commissionPct" DECIMAL(5,2) NOT NULL,
    "partnerShare" DECIMAL(19,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "wallet"."SubscriptionStatus" NOT NULL DEFAULT 'active',
    "razorpayOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GymSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GymSubscription_razorpayOrderId_key" ON "wallet"."GymSubscription"("razorpayOrderId");

-- CreateIndex
CREATE INDEX "GymSubscription_customerId_gymId_status_idx" ON "wallet"."GymSubscription"("customerId", "gymId", "status");
