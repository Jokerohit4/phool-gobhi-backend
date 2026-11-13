-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Blood-panel markers on health.BiometricMetric (2026-10-04). Purely additive:
-- four enum values, no column, table or backfill change. Existing rows are
-- untouched and every existing metric keeps its current meaning.
--
-- Why: BIOLOGICAL_TARGETS (services/ledger/constants.js) defines clinical
-- ranges for exactly these four, and computeBiologicalScore looks each stored
-- marker up in that map. None of the four was a member of the enum, so the
-- lookup missed for every row, totalWeightUsed stayed 0, the function returned
-- null, and the biological 60% of the blended score contributed nothing to any
-- user. The failure was silent — a null that reads as "no data yet".
--
-- In the schema this enum also types ReportExtraction.metric, so it widens what
-- an OCR lab report can be recorded as. Do not go looking for that here yet:
-- health.HealthReport and health.ReportExtraction are declared in schema.prisma
-- and created by no migration (checked against dev 2026-10-04), so the report
-- path fails on "relation does not exist" long before it reaches this enum. That
-- gap is its own fix - the four values above stand on their own.
--
-- Applying this on its own changes nothing a user can reach. A marker becomes
-- writable only once the HTTP allow-list knows it: METRIC_UNITS in
-- services/biometricService.js, which biometricController derives METRICS
-- from, plus a matching METRIC_BOUNDS range. Those land in the same commit,
-- and test/schemaMigrationParity.test.js asserts the two agree from now on so
-- the enum cannot quietly drift away from the service again.

ALTER TYPE "health"."BiometricMetric" ADD VALUE IF NOT EXISTS 'hba1c';
ALTER TYPE "health"."BiometricMetric" ADD VALUE IF NOT EXISTS 'ldl';
ALTER TYPE "health"."BiometricMetric" ADD VALUE IF NOT EXISTS 'hdl';
ALTER TYPE "health"."BiometricMetric" ADD VALUE IF NOT EXISTS 'triglycerides';

-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside the same transaction as a
-- statement that uses the new value. Nothing in this file uses them, so it is
-- safe to apply as a single transaction, and it is deliberately kept to the
-- four statements so it stays that way. A future migration in this series that
-- both adds a value and writes a row using it must be split: run the ALTER
-- first, commit, then apply the rest.
