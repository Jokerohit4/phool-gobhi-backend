-- Feature-flag backfill — run ONCE per environment, by hand, with approval.
-- Generated 2026-10-04 from services/auth-service/config/featureFlagRegistry.js
-- (20 flags, FLAG_SCHEMA_VERSION = 2). Do not hand-edit the flag list in here;
-- regenerate it from the registry instead, or the two drift and this file
-- becomes a fifth copy of the defaults — the exact problem the registry fixed.
--
-- WHY THIS EXISTS
--   Stored config blobs predate `workoutTracking` and `healthVault`. Absent keys
--   resolve to the registry default, which is fail-closed, so after deploying the
--   split both flags read `false` in every environment. Until this runs:
--     - the workout engine is unreachable (its transitional shim accepts either
--       `workoutTracking` OR `healthMetrics`, so it keeps working, but the client
--       composes both and hides the UI);
--     - the vault stays off, which is intended, but for the wrong reason.
--
-- WHAT IT DOES
--   1. `workoutTracking.enabled` := the current `healthMetrics.enabled` value, so
--      today's behaviour is preserved exactly rather than re-decided.
--   2. `healthVault.enabled` := false (legal sign-off pending on report upload).
--   3. Adds any registry flag the blob is missing, at its registry default, so
--      the stored key set matches the registry and `flagsKnown` has nothing to
--      report.
--
-- IDEMPOTENT. Re-running re-derives `workoutTracking` from `healthMetrics` and
-- leaves everything else alone, so it is safe to run twice. Do NOT run it after
-- an operator has deliberately set `workoutTracking` to something other than
-- `healthMetrics` — it would overwrite that choice. Check step 0's output first.
--
-- EXECUTED ON DEV 2026-10-04. Prod has NOT been run — its blob predates the
-- registry entirely and its auth-service has not been redeployed yet.
--
-- Two defects were found by running step 0 against real dev Postgres, after
-- this file had been hand-reviewed and left in place unexecuted:
--   1. `jsonb_object_length()` does not exist in PostgreSQL. Every statement
--      using it failed; counting object keys needs jsonb_object_keys() in a
--      subquery. Fixed above. A hand review cannot catch this, and it failed
--      on the very first statement.
--   2. Steps 1-2 left `updatedBy` pointing at whoever last saved the blob
--      through the portal while stamping a fresh `updatedAt`, which filed an
--      automated change under a real person's name. Both steps now clear it,
--      and step 2b writes the AppConfigHistory row that the raw SQL skipped.
--
-- Dev result, for the record: the blob held 15 of 20 registry flags. The five
-- missing (workoutTracking, healthVault, fhirExport, referral, runTracker) were
-- added; `workoutTracking` mirrored `healthMetrics` (true); `healthVault` was
-- set false; no flag that was true became false. Before the run, `otp` and
-- `profileCompletionBonus` were confirmed NOT stored in the blob — getAppConfig
-- overlays them from their own singleton rows — so step 3b's `unknown_in_blob`
-- list is genuinely empty rather than accidentally empty.
--
-- Run steps 1, 2 and 2b in ONE transaction and roll back unless
-- workout_tracking = health_metrics AND no flag moved true->false.
--
-- DO NOT DO THE FOLLOW-UPS YET, even though dev is backfilled.
--
-- The original note here said the two cleanups "become safe" after a
-- successful backfill. That was wrong in a way that would have broken prod.
-- The backfill is PER ENVIRONMENT; the code it unblocks is ONE codebase
-- deployed to every environment. Dev being backfilled says nothing about prod,
-- whose blob still has no `workoutTracking` key at all. Deleting
-- `requireAnyFeatureFlag` today resolves `workoutTracking` to its fail-closed
-- default in prod and 403s every workout route there, on the one code path the
-- backfill was supposed to make unnecessary.
--
-- So the shim stays until BOTH environments are backfilled, and the removal
-- lands as a single change after the prod run:
--   - narrow health-service `metricsGated` to require `workoutTracking` as well
--     as `healthMetrics` (docs/FEATURE-FLAG-SPLIT.md §5, §8 step 8);
--   - delete `requireAnyFeatureFlag` / `isAnyFeatureEnabled` and repoint
--     `workoutGated` at `requireFeatureFlag('workoutTracking')` alone (§8 step 7).
-- Both in the same change, and only once prod's step 0 shows workout_tracking_now
-- populated. Never before.

-- ============================================================================
-- PREFERRED: do this through the admin API, not SQL.
--
-- `updateAppConfigAdmin` writes an `AppConfigHistory` row and stamps `updatedBy`.
-- Raw SQL does neither — you get an unaudited flag change, which is precisely
-- the gap §4 of the split doc was opened to close.
--
--   1. GET  /api/auth/app-config/admin            (gobhi token; returns the blob)
--   2. add features.workoutTracking = { "enabled": <features.healthMetrics.enabled> }
--      add features.healthVault    = { "enabled": false }
--      add any other registry flag the blob is missing, at its default
--   3. POST /api/auth/app-config/admin  { "config": <the whole blob> }
--
-- Caveat: that endpoint is a blind whole-blob replace (split doc §7, still
-- unfixed), so step 1-3 is read-modify-write. Do it while nobody else is in the
-- settings page, or a concurrent save can be clobbered. Everything below is the
-- SQL equivalent, for when there is no working portal session.
-- ============================================================================


-- ============================================================================
-- STEP 0 — READ FIRST. Do not skip to step 1 without reading this output.
-- ============================================================================

SELECT
  id,
  "updatedAt",
  "updatedBy",
  config #>> '{features,healthMetrics,enabled}'    AS health_metrics_now,
  config #>> '{features,workoutTracking,enabled}' AS workout_tracking_now,
  config #>> '{features,healthVault,enabled}'      AS health_vault_now,
  (SELECT count(*) FROM jsonb_object_keys(COALESCE(config -> 'features', '{}'::jsonb)))
    AS stored_flag_count
FROM auth."AppVersionSetting"
WHERE id = 1;

-- STOP AND RECONSIDER IF:
--   health_metrics_now IS NULL      -> no stored blob at all. Nothing to mirror;
--                                       just insert the registry defaults and skip
--                                       to the verification query.
--   workout_tracking_now = 'true'   -> someone has already set it deliberately.
--                                       Re-running would reset it to the
--                                       healthMetrics value. Do not run.


-- ============================================================================
-- STEP 1 — flags missing from the blob, at their registry default.
--
-- Run this only if step 0 shows fewer stored keys than the registry has flags.
-- It only ever INSERTS a key that is absent; it never overwrites an existing one,
-- so it cannot undo an operator's choice.
-- ============================================================================

WITH registry_defaults(name, enabled) AS (
  VALUES
    ('workoutTracking', false),
    ('healthMetrics', false),
    ('healthVault', false),
    ('healthLedger', false),
    ('foodPhotoLogging', false),
    ('healthPersonalisation', false),
    ('recapSharing', false),
    ('fitnessAssistant', false),
    ('runTracker', false),
    ('cycleTracking', false),
    ('fhirExport', false),
    ('badges', false),
    ('streaksCoins', false),
    ('challenges', false),
    ('buddyPairedStreaks', false),
    ('buddy', true),
    ('referral', true),
    ('brandedOnboarding', false),
    ('homeTrackHome', false),
    ('nonPartnerAttendance', false)
),
current_blob AS (
  SELECT COALESCE(config -> 'features', '{}'::jsonb) AS features
  FROM auth."AppVersionSetting"
  WHERE id = 1
)
UPDATE auth."AppVersionSetting" AS s
SET config = jsonb_set(
      s.config,
      '{features}',
      (
        SELECT jsonb_object_agg(d.name, jsonb_build_object('enabled', d.enabled))
        FROM registry_defaults d
      ) || c.features,
      true
    ),
    "updatedAt" = now(),
    -- Cleared deliberately. The backfill is not an operator's save, and leaving
    -- the previous editor's id here while stamping a new updatedAt would file
    -- this change under their name. Step 4 records it against nobody instead.
    "updatedBy" = NULL
FROM current_blob c
WHERE s.id = 1
RETURNING id AS touched;


-- ============================================================================
-- STEP 2 — the actual backfill.
--
--   workoutTracking := healthMetrics   (mirror, do not re-decide)
--   healthVault    := false            (legal sign-off pending)
--
-- The `|| jsonb_build_object(...)` merge preserves any sibling keys already
-- present inside those two flag objects (e.g. a future `minVersion`), and
-- COALESCE supplies the object where the key was entirely absent.
-- ============================================================================

UPDATE auth."AppVersionSetting"
SET config = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(config, '{}'::jsonb),
          '{features}',
          COALESCE(config -> 'features', '{}'::jsonb),
          true
        ),
        '{features,workoutTracking}',
        COALESCE(config #> '{features,workoutTracking}', '{"enabled": false}'::jsonb)
          || jsonb_build_object(
               'enabled',
               COALESCE((config #>> '{features,healthMetrics,enabled}')::boolean, false)
             ),
        true
      ),
      '{features,healthVault}',
      COALESCE(config #> '{features,healthVault}', '{"enabled": false}'::jsonb)
        || jsonb_build_object('enabled', false),
      true
    ),
    "updatedAt" = now(),
    "updatedBy" = NULL
WHERE id = 1
RETURNING
  config #>> '{features,healthMetrics,enabled}'    AS health_metrics,
  config #>> '{features,workoutTracking,enabled}' AS workout_tracking,
  config #>> '{features,healthVault,enabled}'      AS health_vault,
  "updatedBy";

-- EXPECT: workout_tracking = health_metrics, health_vault = false.
-- workout_tracking = health_metrics proves the mirror worked.
-- workout_tracking <> health_metrics means the COALESCE fell through to false,
-- i.e. healthMetrics was NULL — go back to step 0 and read the blob by hand.


-- ============================================================================
-- STEP 2b — AUDIT ROW. Run inside the same transaction as steps 1 and 2.
--
-- Steps 1-2 write the blob without going through updateAppConfigAdmin, so
-- nothing records that they did. Without this the config table shows a changed
-- value with no history explaining it — the exact gap the split doc opened in
-- the first place. changedBy is NULL because no operator made this change.
--
-- Bind the three json parameters from the features blob captured BEFORE step 1
-- and the one read back after step 2. changedFlags should be the names whose
-- value actually differs, which on a first run is exactly the flags the blob
-- was missing.
-- ============================================================================

INSERT INTO auth."AppConfigHistory" ("changedFlags", before, after, note, "changedBy", "createdAt")
VALUES (
  $1::text[],   -- changedFlags: e.g. {workoutTracking,healthVault,fhirExport,referral,runTracker}
  $2::jsonb,    -- before: the features object as it was before step 1
  $3::jsonb,    -- after:  the features object as it reads after step 2
  'backfill: mirror workoutTracking from healthMetrics, add missing registry flags at defaults (docs/FEATURE-FLAG-BACKFILL.sql). Automated; not an operator change.',
  NULL,
  now()
)
RETURNING id, "changedFlags";


-- ============================================================================
-- STEP 3 — VERIFY. Read-only; safe to run any time.
-- ============================================================================

-- 3a. The two flags landed, and the mirror held.
SELECT
  config #>> '{features,workoutTracking,enabled}' AS workout_tracking,
  config #>> '{features,healthMetrics,enabled}'    AS health_metrics,
  config #>> '{features,healthVault,enabled}'      AS health_vault,
  (config #>> '{features,workoutTracking,enabled}')
    IS NOT DISTINCT FROM
  (config #>> '{features,healthMetrics,enabled}')  AS mirror_ok,
  (SELECT count(*) FROM jsonb_object_keys(COALESCE(config -> 'features', '{}'::jsonb)))
    AS stored_flag_count
FROM auth."AppVersionSetting"
WHERE id = 1;

-- 3b. Every registry flag is present in the blob, and nothing else is.
--     Both lists should come back empty.
WITH registry_flags(name) AS (
  VALUES
    ('workoutTracking'),
    ('healthMetrics'),
    ('healthVault'),
    ('healthLedger'),
    ('foodPhotoLogging'),
    ('healthPersonalisation'),
    ('recapSharing'),
    ('fitnessAssistant'),
    ('runTracker'),
    ('cycleTracking'),
    ('fhirExport'),
    ('badges'),
    ('streaksCoins'),
    ('challenges'),
    ('buddyPairedStreaks'),
    ('buddy'),
    ('referral'),
    ('brandedOnboarding'),
    ('homeTrackHome'),
    ('nonPartnerAttendance')
),
stored AS (
  SELECT jsonb_object_keys(COALESCE(config -> 'features', '{}'::jsonb)) AS name
  FROM auth."AppVersionSetting"
  WHERE id = 1
)
SELECT 'missing_from_blob' AS problem, name FROM registry_flags
  WHERE name NOT IN (SELECT name FROM stored)
UNION ALL
SELECT 'unknown_in_blob', name FROM stored
  WHERE name NOT IN (SELECT name FROM registry_flags);

-- 3c. The migration landed (step 2 was SQL, so it wrote no history row —
--     this is expected, and is the argument for using the admin API instead).
SELECT count(*) AS history_rows
FROM auth."AppConfigHistory";
