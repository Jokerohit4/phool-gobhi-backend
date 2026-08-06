-- Singleton row (id always 1) — admin-portal-editable wallet top-up
-- options (presets + optional custom-amount range), read by
-- createTopUpOrder's amount check. getWalletTopupConfig() falls back to an
-- in-code default when this table is empty, so no seed row is needed here.
CREATE TABLE "wallet"."WalletTopupConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "presets" JSONB NOT NULL,
    "allowCustomAmount" BOOLEAN NOT NULL DEFAULT false,
    "minCustomAmount" DECIMAL(19,2),
    "maxCustomAmount" DECIMAL(19,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "WalletTopupConfig_pkey" PRIMARY KEY ("id")
);
