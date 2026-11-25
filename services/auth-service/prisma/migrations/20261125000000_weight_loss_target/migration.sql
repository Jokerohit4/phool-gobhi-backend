SET lock_timeout = '3s';

ALTER TABLE "auth"."User" ADD COLUMN "weightLossTargetKg" DOUBLE PRECISION;
