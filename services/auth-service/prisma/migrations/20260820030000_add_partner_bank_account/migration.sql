-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- A partner's bank details for the attendance-SaaS bank-settlement flow —
-- plain columns, not encrypted at rest (see schema.prisma comment).

CREATE TABLE IF NOT EXISTS "auth"."PartnerBankAccount" (
    "id" SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifscCode" TEXT NOT NULL,
    "upiId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "PartnerBankAccount_userId_key" ON "auth"."PartnerBankAccount"("userId");

-- No explicit ON DELETE behavior specified in schema.prisma's @relation
-- (matches SavedAddress's existing pattern in this same file), so this
-- defaults to RESTRICT rather than CASCADE.
ALTER TABLE "auth"."PartnerBankAccount"
  ADD CONSTRAINT "PartnerBankAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "auth"."User"("id");
