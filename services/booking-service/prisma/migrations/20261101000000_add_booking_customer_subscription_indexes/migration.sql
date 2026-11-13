-- Customer-scoped read paths (booking list, attendance history, subscription
-- visit counts). Index-only, no data change. IF NOT EXISTS keeps a re-apply or
-- a hand-created index from failing the deploy.
CREATE INDEX IF NOT EXISTS "Booking_customerId_createdAt_idx" ON "booking"."Booking"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "Booking_customerId_attendedAt_idx" ON "booking"."Booking"("customerId", "attendedAt");
CREATE INDEX IF NOT EXISTS "Booking_subscriptionId_idx" ON "booking"."Booking"("subscriptionId");
