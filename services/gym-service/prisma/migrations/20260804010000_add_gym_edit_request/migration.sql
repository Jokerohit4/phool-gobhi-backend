-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Partner edits to an already-approved (live) gym no longer write straight
-- to Gym/GymImage/SlotBlock/GymSlotPrice — they land here as a pending
-- request until a gobhi approves/rejects it. See gymService.js's
-- isApproved gate.

CREATE TYPE "gym"."EditRequestType" AS ENUM ('profile', 'image_add', 'image_delete', 'doc_add', 'doc_delete', 'slot_prices', 'slot_block_add', 'slot_block_delete');

CREATE TYPE "gym"."EditRequestStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "gym"."GymEditRequest" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "changeType" "gym"."EditRequestType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "gym"."EditRequestStatus" NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT,
    "reviewedBy" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GymEditRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GymEditRequest_gymId_status_idx" ON "gym"."GymEditRequest"("gymId", "status");

CREATE INDEX "GymEditRequest_status_idx" ON "gym"."GymEditRequest"("status");

ALTER TABLE "gym"."GymEditRequest" ADD CONSTRAINT "GymEditRequest_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;
