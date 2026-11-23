-- Lifecycle nudges for brand-new users (2026-11-23).
--
-- Production analytics showed 16 of 27 recent customer-app signups never came
-- back on a later day, and none of them was eligible for any existing nudge
-- (log needs an attendance record, comeback needs a COMPLETED workout, target
-- needs a score target). These values let the nudge sweep record the new
-- lifecycle sends in NudgeLog, which is also how "never send the same
-- lifecycle nudge twice" is enforced.
--
--   onboarding_resume   - signed up, never finished onboarding
--   first_step          - finished onboarding, no first activity after ~24h
--   first_step_followup - still nothing at ~72h
--   lifecycle           - opt-out switch ONLY. NudgeOptOut shares this enum;
--                         one `lifecycle` row silences all three types above,
--                         so the settings screen gets one toggle, not three.
--
-- Separate values (not reusing `comeback`) so a user can silence first-week
-- nudges without silencing comebacks, and so each one can be sent exactly once.
--
-- ALTER TYPE ... ADD VALUE cannot share a transaction with a statement that
-- uses the new value; this file only adds values.
ALTER TYPE "health"."NudgeType" ADD VALUE IF NOT EXISTS 'onboarding_resume';
ALTER TYPE "health"."NudgeType" ADD VALUE IF NOT EXISTS 'first_step';
ALTER TYPE "health"."NudgeType" ADD VALUE IF NOT EXISTS 'first_step_followup';
ALTER TYPE "health"."NudgeType" ADD VALUE IF NOT EXISTS 'lifecycle';
