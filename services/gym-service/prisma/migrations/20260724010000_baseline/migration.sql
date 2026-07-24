-- Baseline migration — gym-service had no prisma/migrations/ history at all
-- (schema was applied via `db push` up to now). Generated via
-- `prisma migrate diff --from-empty --to-schema-datamodel` against the
-- current schema.prisma, so this SQL reflects the schema as it exists today.
--
-- The real dev/prod DB already has these tables (from db push) — do NOT run
-- this migration for real against them, or every CREATE TABLE will fail with
-- "already exists". Instead, baseline it:
--   npx prisma migrate resolve --applied 20260724010000_baseline
-- run once per environment (dev, then prod) so Prisma's _prisma_migrations
-- table records this as already-applied, and every migration added after
-- this point (including 20260724000000_add_booking_commission-equivalent
-- future changes to this service) can go through normal
-- `prisma migrate deploy`. Only a genuinely fresh/empty DB (e.g. a new
-- environment stood up from scratch) should actually execute this SQL.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "gym";

-- CreateTable
CREATE TABLE "gym"."Gym" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "amenities" TEXT[],
    "phone" TEXT NOT NULL,
    "sessionPrice" DOUBLE PRECISION NOT NULL,
    "quotedPrice" DOUBLE PRECISION,
    "established" INTEGER,
    "brandDocs" TEXT[],
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "slotDuration" INTEGER NOT NULL DEFAULT 60,
    "capacity" INTEGER NOT NULL DEFAULT 20,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "weeklyPlanPrice" DOUBLE PRECISION,
    "monthlyPlanPrice" DOUBLE PRECISION,
    "quarterlyPlanPrice" DOUBLE PRECISION,
    "yearlyPlanPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gym_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym"."GymImage" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GymImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym"."GymReview" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GymReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym"."SlotBlock" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym"."GymSlotPrice" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GymSlotPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Gym_partnerId_idx" ON "gym"."Gym"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "GymReview_gymId_customerId_key" ON "gym"."GymReview"("gymId", "customerId");

-- CreateIndex
CREATE INDEX "SlotBlock_gymId_date_idx" ON "gym"."SlotBlock"("gymId", "date");

-- CreateIndex
CREATE INDEX "GymSlotPrice_gymId_idx" ON "gym"."GymSlotPrice"("gymId");

-- CreateIndex
CREATE UNIQUE INDEX "GymSlotPrice_gymId_startTime_key" ON "gym"."GymSlotPrice"("gymId", "startTime");

-- AddForeignKey
ALTER TABLE "gym"."GymImage" ADD CONSTRAINT "GymImage_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym"."GymReview" ADD CONSTRAINT "GymReview_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym"."SlotBlock" ADD CONSTRAINT "SlotBlock_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym"."GymSlotPrice" ADD CONSTRAINT "GymSlotPrice_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

