-- Hand-authored, additive migration: what a gym owner records about one of its own
-- members, kept per (gym, member). New tables only, no change to existing tables:
-- safe to apply online. Reconcile against dev/prod before applying, same caveat as
-- the preceding hand-authored migrations (no shadow DB here to run `prisma migrate dev`).
--
-- GymMemberRecord: one row per (gym, member) of owner-entered details. The phone
-- here is whatever number the OWNER typed from their own records; the customer's
-- own phone is never exposed to partners (see gymRoster).
-- GymMemberPayment: a ledger. Members renew, so each payment is its own row;
-- "valid until" and lifetime paid are derived from it rather than overwritten.
-- Dates are IST calendar dates stored as 'YYYY-MM-DD' strings, matching the
-- date columns elsewhere; money is stored in paise.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "auth"."GymMemberRecord" (
  "gymId"                 INTEGER      NOT NULL,
  "userId"                INTEGER      NOT NULL,
  "phone"                 TEXT,
  "emergencyContactName"  TEXT,
  "emergencyContactPhone" TEXT,
  "lockerNumber"          TEXT,
  "joinedOn"              TEXT,
  "followUpOn"            TEXT,
  "amountDuePaise"        INTEGER,
  "notes"                 TEXT,
  "updatedByPartnerId"    INTEGER,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GymMemberRecord_pkey" PRIMARY KEY ("gymId", "userId")
);

CREATE INDEX IF NOT EXISTS "GymMemberRecord_userId_idx" ON "auth"."GymMemberRecord" ("userId");

CREATE TABLE IF NOT EXISTS "auth"."GymMemberPayment" (
  "id"                 SERIAL       NOT NULL,
  "gymId"              INTEGER      NOT NULL,
  "userId"             INTEGER      NOT NULL,
  "amountPaise"        INTEGER      NOT NULL,
  "paidOn"             TEXT         NOT NULL,
  "paymentMode"        TEXT,
  "planName"           TEXT,
  "validUntil"         TEXT,
  "note"               TEXT,
  "createdByPartnerId" INTEGER,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GymMemberPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GymMemberPayment_gymId_userId_idx" ON "auth"."GymMemberPayment" ("gymId", "userId");
CREATE INDEX IF NOT EXISTS "GymMemberPayment_userId_idx" ON "auth"."GymMemberPayment" ("userId");
