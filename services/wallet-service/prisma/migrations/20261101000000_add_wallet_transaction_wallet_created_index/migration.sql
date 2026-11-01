-- Transaction history is read per wallet, newest first; WalletTransaction had
-- no index on walletId. Index-only, no data change.
CREATE INDEX IF NOT EXISTS "WalletTransaction_walletId_createdAt_idx" ON "wallet"."WalletTransaction"("walletId", "createdAt");
