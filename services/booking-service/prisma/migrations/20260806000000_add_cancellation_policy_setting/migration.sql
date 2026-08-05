-- Backfills a table this repo's schema.prisma has had since commit b8c7251
-- (Jul 22) but never got a migration for — it only ever existed in dev
-- because someone ran `prisma db push` there directly at some point; prod
-- (migrate-deploy only, never db-push) never got the table at all, so every
-- GET/PUT to the admin settings page's cancellation-policy section 500s
-- there with "relation booking.CancellationPolicySetting does not exist".
--
-- Singleton row (id always 1) — admin-portal-editable cancellation refund
-- tiers, read by cancelBooking's refund calc. getCancellationPolicy() falls
-- back to an in-code default when this table is empty, so no seed row is
-- needed here either.
CREATE TABLE IF NOT EXISTS "booking"."CancellationPolicySetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tiers" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "CancellationPolicySetting_pkey" PRIMARY KEY ("id")
);
