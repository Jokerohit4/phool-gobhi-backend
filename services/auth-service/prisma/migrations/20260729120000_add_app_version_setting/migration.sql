-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations: reconcile against the actual dev/prod DB before applying.
--
-- Force/soft-update feature: singleton config row read by
-- GET /api/auth/app-config, admin-editable via GET/PUT
-- /api/auth/app-config/admin. getAppConfig() falls back to an in-code
-- default if this table is empty, so the app never needs a seed row.

CREATE TABLE IF NOT EXISTS "auth"."AppVersionSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "AppVersionSetting_pkey" PRIMARY KEY ("id")
);
