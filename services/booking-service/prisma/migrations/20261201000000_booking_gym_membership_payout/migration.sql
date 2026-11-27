CREATE TABLE "booking"."GymMembershipPayout" (
    "gymId" INTEGER PRIMARY KEY CHECK ("gymId" > 0),
    "payoutPaise" INTEGER NOT NULL CHECK ("payoutPaise" > 0),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER
);
