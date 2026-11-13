-- Hand-authored migration (no DATABASE_URL/shadow DB in the authoring environment
-- to run `prisma migrate dev`). Reconcile against the actual dev/prod DB before
-- applying - same caveat as the neighbouring migrations.
--
-- health.HealthReport and health.ReportExtraction are declared in schema.prisma
-- and are what the lab-report upload path writes to (routes/health.js ->
-- reportService -> ocrService), but no migration has ever created either of them:
-- 48 models in the schema, 46 tables on dev. Every call into that path died on
-- `relation "health"."HealthReport" does not exist`, well before the OCR marker
-- mapping or anything else interesting could run.
--
-- Purely structural. Nothing about who may write here is decided in this file: the
-- consent gating on those routes is untouched by this migration, and whether lab
-- results belong under a scope wider than the "logs" default on HealthConsent is
-- still an open product/legal question. Creating the tables grants no access to
-- them - an absent table was not access control, it was an outage wearing one.
--
-- Two dependencies worth stating, both satisfied by migration order:
--   - "health"."BiometricMetric" types ReportExtraction.metric. It is widened by
--     20261006000000_add_blood_panel_markers to the eleven values the OCR marker
--     map can emit, so this CREATE TABLE now accepts what that path produces.
--     Against a database migrated before that, it would not.
--   - "health"."ReportStatus" is created here, since nothing before this needed it.
--
-- No IF NOT EXISTS on the CREATE statements, deliberately: these tables must not
-- exist, and if they ever do the right answer is to find out why rather than have
-- the migration shrug and apply a shape that may not match. The whole file is one
-- transaction, so a failure leaves nothing behind.

CREATE TYPE "health"."ReportStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'REVIEW_REQUIRED'
);

-- userId is a plain integer with no @relation in the schema, so there is no
-- foreign key to a users table here - matching what Prisma generates, and leaving
-- the choice of that constraint to whoever defines the user relation.
CREATE TABLE "health"."HealthReport" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "cloudinaryUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "health"."ReportStatus" NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthReport_pkey" PRIMARY KEY ("id")
);

-- normalizedValue is DECIMAL(8,2) rather than a float because a lab value is a
-- reported measurement, not a computed one, and float is a lossy way to keep 5.7.
CREATE TABLE "health"."ReportExtraction" (
    "id" SERIAL NOT NULL,
    "reportId" INTEGER NOT NULL,
    "metric" "health"."BiometricMetric" NOT NULL,
    "rawValue" TEXT NOT NULL,
    "normalizedValue" DECIMAL(8,2),
    "unit" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportExtraction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HealthReport_userId_idx" ON "health"."HealthReport"("userId");
CREATE INDEX "ReportExtraction_reportId_idx" ON "health"."ReportExtraction"("reportId");

-- onDelete: Cascade, from the schema. Deleting a report takes its extractions with
-- it, which is what the erasure path wants.
ALTER TABLE "health"."ReportExtraction"
    ADD CONSTRAINT "ReportExtraction_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "health"."HealthReport"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
