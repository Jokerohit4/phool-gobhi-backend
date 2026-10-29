ALTER TABLE "health"."MedicalDocument" ADD COLUMN "structuredPlan" JSONB;
ALTER TABLE "health"."MedicalDocument" ADD COLUMN "supersededAt" TIMESTAMP(3);
