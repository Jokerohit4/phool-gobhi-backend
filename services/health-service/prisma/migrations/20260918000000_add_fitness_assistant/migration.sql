-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Fitness assistant (2026-09-18). Purely additive; no existing table, column
-- or index is touched, so applying this is a no-op for every current path.

DO $$ BEGIN
  CREATE TYPE "health"."AssistantRole" AS ENUM ('user', 'assistant');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "health"."AssistantConversation" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "summarizedThroughMessageId" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "health"."AssistantMessage" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "health"."AssistantRole" NOT NULL,
    "content" TEXT NOT NULL,
    "policyVersion" TEXT,
    "promptVersion" TEXT,
    "providerModel" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "latencyMs" INTEGER,
    "usedContext" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "health"."AssistantConsent" (
    "userId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantConsent_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."AssistantMemory" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "health"."AssistantRateLimitLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantRateLimitLog_pkey" PRIMARY KEY ("id")
);

-- Cascade so deleting a conversation takes its messages with it, and so the
-- DPDPA erasure path doesn't depend on getting the delete order right.
DO $$ BEGIN
  ALTER TABLE "health"."AssistantMessage"
    ADD CONSTRAINT "AssistantMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "health"."AssistantConversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "AssistantConversation_userId_updatedAt_idx"
  ON "health"."AssistantConversation"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "AssistantMessage_conversationId_createdAt_idx"
  ON "health"."AssistantMessage"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantMessage_userId_createdAt_idx"
  ON "health"."AssistantMessage"("userId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantMemory_userId_key_key"
  ON "health"."AssistantMemory"("userId", "key");
-- The rate-limit window query is (userId, sentAt >= cutoff); without this it
-- degrades to a scan that gets slower exactly as a user sends more.
CREATE INDEX IF NOT EXISTS "AssistantRateLimitLog_userId_sentAt_idx"
  ON "health"."AssistantRateLimitLog"("userId", "sentAt");
