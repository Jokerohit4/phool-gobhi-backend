-- Hand-authored migration (same caveat as the preceding ones: no
-- DATABASE_URL/shadow DB in this environment to run `prisma migrate dev`).
--
-- Indexes for the Razorpay top-up reconciliation sweep
-- (reconcilePendingRazorpayOrdersService in walletService.js):
--   * (status, createdAt)  — the periodic global sweep scans stale PENDING rows
--   * (userId, status)     — the lazy per-customer reconcile on wallet reads
-- Both are tiny scans either way at current volume; the indexes just keep
-- them from growing linearly with the order table as the platform scales.

CREATE INDEX IF NOT EXISTS "RazorpayOrder_status_createdAt_idx"
    ON "wallet"."RazorpayOrder" ("status", "createdAt");

CREATE INDEX IF NOT EXISTS "RazorpayOrder_userId_status_idx"
    ON "wallet"."RazorpayOrder" ("userId", "status");
