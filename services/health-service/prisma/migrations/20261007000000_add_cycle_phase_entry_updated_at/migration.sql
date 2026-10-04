-- Schema/migration drift fix (2026-10-04).
--
-- schema.prisma declares `updatedAt DateTime @updatedAt` on CyclePhaseEntry;
-- 20260918020000_add_cycle_tracking's CREATE TABLE left the column out. Prisma
-- includes @updatedAt columns in every INSERT and UPDATE it builds, so the first
-- person to log a cycle phase would have hit `column "updatedAt" does not exist`
-- from cycleTrackingService.js:127.
--
-- Found by auditing schema.prisma against the live database rather than by a user
-- report, because the table has no rows on dev - nothing had exercised the write
-- path yet. That is also why nothing had gone red.
--
-- NOT NULL with a default is deliberate: it matches what Prisma would have
-- written, and on a table that does acquire rows later the existing ones get the
-- migration time instead of failing. IF NOT EXISTS because this one is a repair
-- rather than a new object, and re-running a repair should be a no-op.

ALTER TABLE "health"."CyclePhaseEntry"
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
