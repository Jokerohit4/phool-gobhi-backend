-- AlterTable
ALTER TABLE "health"."HealthReport" ADD COLUMN "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
ADD COLUMN "proposedMarkers" JSONB,
ADD COLUMN "proposedProfile" JSONB,
ADD COLUMN "readConsentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "health"."GuidanceProfile" (
    "userId" INTEGER NOT NULL,
    "sourceReportId" INTEGER,
    "confirmedDetails" JSONB NOT NULL DEFAULT '{}',
    "confirmedMarkers" JSONB NOT NULL DEFAULT '{}',
    "liverFlag" BOOLEAN NOT NULL DEFAULT false,
    "riskBucket" TEXT NOT NULL DEFAULT 'UNSET',
    "confirmedAt" TIMESTAMP(3),
    "concern" TEXT,
    "existingAdvice" TEXT,
    "clinicalStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "clinicalNote" TEXT,
    "clinicianName" TEXT,
    "clinicianRegistration" TEXT,
    "reviewedBy" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "agreedActions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidanceProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "health"."GuidanceRequest" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "preferredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuidanceRequest_userId_createdAt_idx" ON "health"."GuidanceRequest"("userId", "createdAt");

ALTER TABLE "health"."GuidanceProfile"
  ADD CONSTRAINT "GuidanceProfile_riskBucket_check" CHECK ("riskBucket" IN ('UNSET', 'GREEN', 'AMBER', 'RED')),
  ADD CONSTRAINT "GuidanceProfile_clinicalStatus_check" CHECK ("clinicalStatus" IN ('PENDING', 'CLEARED', 'FOLLOW_UP_REQUIRED', 'NOT_CLEARED'));
ALTER TABLE "health"."GuidanceRequest"
  ADD CONSTRAINT "GuidanceRequest_kind_check" CHECK ("kind" IN ('COACH_CALL', 'DOCTOR_CALL', 'DIETITIAN_REVIEW', 'QUESTION', 'FORM_SESSION')),
  ADD CONSTRAINT "GuidanceRequest_status_check" CHECK ("status" IN ('REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED'));


ALTER TABLE "health"."HealthReport" ADD COLUMN "processingStartedAt" TIMESTAMP(3), ADD COLUMN "processingToken" TEXT;
