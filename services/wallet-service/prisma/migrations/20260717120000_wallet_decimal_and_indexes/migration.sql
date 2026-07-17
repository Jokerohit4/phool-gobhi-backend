-- Hand-authored migration (no DATABASE_URL/shadow DB was available in this
-- environment to run `prisma migrate dev`). This assumes the deployed dev DB
-- already matches pre-existing schema.prisma (multiSchema "wallet", the
-- RazorpayOrder table, WalletStatus/TransactionStatus enums, etc.) — note
-- that the only tracked migration before this one ("20250729161734_init")
-- predates all of that, which means the real dev/prod DB was very likely
-- synced at some point via `prisma db push` rather than tracked migrations.
-- Before applying this, reconcile migration history against the actual dev
-- DB (e.g. `prisma migrate diff` against it, or `prisma migrate resolve` for
-- any gap) rather than trusting this file blindly — it was authored from
-- schema.prisma only, not verified against a live database.

-- AlterTable: Wallet.balance Float -> Decimal(19,2)
ALTER TABLE "wallet"."Wallet"
  ALTER COLUMN "balance" TYPE DECIMAL(19,2) USING "balance"::numeric(19,2);

-- AlterTable: WalletTransaction.amount Float -> Decimal(19,2)
ALTER TABLE "wallet"."WalletTransaction"
  ALTER COLUMN "amount" TYPE DECIMAL(19,2) USING "amount"::numeric(19,2);

-- AlterTable: RazorpayOrder.amount Float -> Decimal(19,2)
ALTER TABLE "wallet"."RazorpayOrder"
  ALTER COLUMN "amount" TYPE DECIMAL(19,2) USING "amount"::numeric(19,2);

-- CreateIndex: Postgres unique indexes allow multiple NULLs, so these still
-- allow many un-set razorpayOrderId/razorpayPaymentId rows while catching a
-- real duplicate non-null value.
CREATE UNIQUE INDEX "WalletTransaction_razorpayOrderId_key" ON "wallet"."WalletTransaction"("razorpayOrderId");
CREATE UNIQUE INDEX "WalletTransaction_razorpayPaymentId_key" ON "wallet"."WalletTransaction"("razorpayPaymentId");
