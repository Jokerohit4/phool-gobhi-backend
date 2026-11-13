-- Additive prerequisite repair discovered by the isolated historical replay.
-- Existing migration bytes/history are immutable. July's schema-qualified SQL
-- relied on tables/columns originally provisioned outside the migration chain.
-- Sort before those consumers so a new database is reproducible too. Existing
-- application databases already contain these objects; preserve their rows.
SET lock_timeout = '3s';
CREATE SCHEMA IF NOT EXISTS auth;

DO $$
DECLARE type_name text;
BEGIN
  -- Old URLs defaulted to public; new URLs may explicitly select auth.
  IF to_regclass('auth."User"') IS NULL AND to_regclass('public."User"') IS NOT NULL THEN
    ALTER TABLE public."User" SET SCHEMA auth;
  END IF;
  FOREACH type_name IN ARRAY ARRAY['Role','UserType','GobhiType'] LOOP
    IF to_regtype(format('auth.%I', type_name)) IS NULL AND to_regtype(format('public.%I', type_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TYPE public.%I SET SCHEMA auth', type_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE auth."User"
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN password DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "profileImageUrl" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "fcmToken" text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON auth."User"(phone);

CREATE TABLE IF NOT EXISTS auth."SavedAddress" (
  id serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES auth."User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  label text NOT NULL,
  "formattedAddress" text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
