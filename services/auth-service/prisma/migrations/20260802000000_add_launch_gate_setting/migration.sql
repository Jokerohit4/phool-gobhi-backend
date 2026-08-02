-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations: reconcile against the actual dev/prod DB before applying.
--
-- Launch gate: singleton config row read by public GET /api/auth/launch-status,
-- admin-editable via GET/PUT /api/auth/launch-gate/admin. No row (or
-- enabled=false) means the website is always live — the gate does nothing
-- until an admin deliberately enables it and/or sets a launchAt.

CREATE TABLE IF NOT EXISTS "auth"."LaunchGateSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "launchAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "LaunchGateSetting_pkey" PRIMARY KEY ("id")
);
