-- name was previously required and defaulted to the literal string 'User' at
-- signup (phone+OTP signup never collects a name) — making it nullable lets
-- each app prompt for the real name once, after first login, instead of
-- masking "never asked" as a fake value.
ALTER TABLE "auth"."User" ALTER COLUMN "name" DROP NOT NULL;
