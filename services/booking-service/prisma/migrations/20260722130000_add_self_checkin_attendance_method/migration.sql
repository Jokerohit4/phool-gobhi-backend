-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment). Same caveat as preceding migrations: reconcile against the
-- actual dev/prod DB before applying.
--
-- Adds a third AttendanceMethod value for the poster-QR + geofence
-- self-check-in flow (customer scans a static per-gym QR, verifies via
-- location instead of a partner scan). Postgres requires ALTER TYPE ... ADD
-- VALUE to run outside a transaction block in older versions — kept as its
-- own statement/migration for that reason.
ALTER TYPE "booking"."AttendanceMethod" ADD VALUE IF NOT EXISTS 'qr_geofence_self';
