-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying (CI runs `prisma migrate deploy` on next
-- gym-service deploy).
--
-- GymLead: partner-owned follow-up pipeline for prospective members (the
-- attendance-SaaS sales side). Partner-scoped bookkeeping; "conversion" is
-- a status the partner records, membership books themselves live in
-- booking-service, so no cross-service FK exists here on purpose.

CREATE TYPE "gym"."LeadStatus" AS ENUM ('new', 'contacted', 'scheduled_visit', 'converted', 'lost');

CREATE TABLE "gym"."GymLead" (
  "id" SERIAL NOT NULL,
  "gymId" INTEGER NOT NULL,
  "partnerId" INTEGER NOT NULL,
  "name" TEXT,
  "phone" TEXT,
  "notes" TEXT,
  "source" TEXT NOT NULL DEFAULT 'walk_in',
  "status" "gym"."LeadStatus" NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GymLead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GymLead_gymId_status_idx" ON "gym"."GymLead"("gymId", "status");
CREATE INDEX "GymLead_partnerId_idx" ON "gym"."GymLead"("partnerId");

ALTER TABLE "gym"."GymLead"
  ADD CONSTRAINT "GymLead_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;