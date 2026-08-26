-- CreateTable: MemberAttendance (attendance-SaaS wedge)
CREATE TABLE "booking"."MemberAttendance" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberAttendance_pkey" PRIMARY KEY ("id")
);

-- One check-in per customer per gym per day
CREATE UNIQUE INDEX "MemberAttendance_customerId_gymId_date_key" ON "booking"."MemberAttendance"("customerId", "gymId", "date");

CREATE INDEX "MemberAttendance_gymId_date_idx" ON "booking"."MemberAttendance"("gymId", "date");

CREATE INDEX "MemberAttendance_customerId_idx" ON "booking"."MemberAttendance"("customerId");
