#!/usr/bin/env node
// Bulk feature-flag seeding for auth-service.
//
// WHY THIS EXISTS
//
// The admin portal's /settings page is the right tool for turning ONE flag on.
// It is the wrong tool for putting an environment into a known state, for three
// reasons, all of which have bitten this codebase:
//
//   1. An unchecked checkbox is not submitted. So "turn everything off" and "the
//      form rendered nothing" arrive as the same empty FormData, and the action
//      cannot tell them apart. There is no bulk control in the portal for
//      exactly this reason.
//   2. The portal only writes flags the server's registry knows about, one
//      toggle at a time, so a 20-flag profile is 20 round trips and 20 chances
//      to stop halfway with a half-applied environment.
//   3. It needs a gobhi session, so it cannot be used from CI, from a deploy
//      hook, or from a laptop at 2am with an incident in progress.
//
// This script addresses flags BY NAME from the registry, so it is immune to all
// three: the same command produces the same state regardless of what any client
// renders, and it needs nothing but DATABASE_URL.
//
// SAFE BY DEFAULT
//
// Dry run is the default and prints the exact diff without writing. Nothing is
// written without --apply. The diff is computed against what is actually stored,
// so the dry run is the thing you paste into a review, not a summary of intent.
//
//   node scripts/seedFeatureFlags.js --list
//   node scripts/seedFeatureFlags.js --profile all-off                 # dry run
//   node scripts/seedFeatureFlags.js --profile all-off --apply --note "incident: kill switch"
//   node scripts/seedFeatureFlags.js --set workoutTracking=on,badges=off
//   node scripts/seedFeatureFlags.js --profile consent-minimal --apply --expect-host prod
//
// Exit codes: 0 success, 1 runtime failure, 2 usage error.

import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  FEATURE_FLAGS,
  defaultFeatures,
  flagNames,
  validateFeaturePayload,
  diffChangedFlags,
} from '../config/featureFlagRegistry.js';

dotenv.config();

// A profile is an explicit decision about which flags are on, so each one states
// what it leaves off. Anything not named is off: an allowlist, never a
// denylist, so a flag added to the registry later is off until somebody says
// otherwise.
//
// Exported so the profile CONTENTS can be asserted in tests - a profile is a
// safety claim about an environment, and `consent-minimal` quietly gaining a
// medical flag would be a serious regression that no CLI-level test would catch.
export const PROFILES = {
  defaults: {
    summary: 'registry defaults (only buddy + referral)',
    on: () => Object.keys(defaultFeatures()).filter((n) => defaultFeatures()[n].enabled),
  },
  'all-off': {
    summary: 'every flag off - incident kill switch',
    // The fail-safe profile. Also the right answer for a fresh environment: with
    // everything off, nothing that collects personal data is reachable until
    // somebody deliberately turns it on.
    on: () => [],
  },
  'all-on': {
    summary: 'EVERY flag on - local/dev only, never prod',
    // Deliberately includes healthVault (uploads medical reports), cycleTracking
    // (reverses FR-27), foodPhotoLogging (sends a photo to a third-party model)
    // and streaksCoins, whose own registry entry says not to enable it until the
    // coin sink exists. Several are held for legal sign-off. This exists for a
    // local database where you want to click through every screen; on a real
    // environment it is the profile you use to discover which surfaces were never
    // finished.
    on: () => flagNames(),
  },
  'consent-minimal': {
    summary: 'only badges - nothing that collects personal data',
    // badges is display-only with no ledger and no coin movement, and its
    // registry entry says it fails OPEN because showing it is harmless. Every
    // other flag either writes user data, moves money, or is a social surface
    // with no moderation (see the buddy entry: no report/block/filter anywhere).
    on: () => ['badges'],
  },
  'launch-candidate': {
    summary: 'marketplace + gym-buddy + referrals + workout log + health scores; medical/AI off',
    // Mirrors the launch table in docs/FEATURE-FLAG-SPLIT.md §9, which is the
    // recorded product decision - this profile is that table made executable,
    // not a second opinion. Still a proposal until somebody signs it off.
    //
    // On: workoutTracking (the daily hook, ~150 sessions/user/year against ~30
    // bookings) and healthMetrics (the differentiator), plus the two flags that
    // are already live in production and default on for that reason - buddy and
    // referral. Then the low-risk no-dependency surfaces: badges, homeTrackHome,
    // nonPartnerAttendance, brandedOnboarding.
    //
    // Off, and each for a recorded reason rather than caution: healthVault
    // (legal sign-off pending on medical report upload), healthLedger and
    // foodPhotoLogging (a photo of someone's plate to a third-party model, and
    // the ledger holds records under a `medical_records` consent scope),
    // cycleTracking (reverses FR-27; consent wording unreviewed), fhirExport
    // (no HAPI validator run yet, so nobody should be handed a file labelled a
    // government-standard record), healthPersonalisation and fitnessAssistant
    // (the two AI surfaces, disclaimer wording unsigned, and personalisation
    // is the only consent-bearing write in health-service), recapSharing and
    // runTracker (not the launch hook), and streaksCoins (its own registry
    // entry says DO NOT ENABLE until the coin sink exists - the app never calls
    // /coins/redeem), challenges (the catalogue is geo-fenced to two cities, so
    // this reads as a broken feature everywhere else) and buddyPairedStreaks
    // (known unmatch bug: coins keep accruing for a match that no longer
    // exists).
    //
    // Note on deps, because it is easy to get backwards: `deps` makes a child
    // INERT while its parent is off. It never switches a child on. So enabling
    // healthMetrics here does NOT implicitly enable healthPersonalisation,
    // cycleTracking or fhirExport - they stay off until named. The reverse
    // relation is the one that bites, which is why workoutTracking is on here:
    // healthMetrics would be dead without it.
    //
    // `coachJourney` (registered 2026-10-16) is the next candidate to name here,
    // right next to workoutTracking — the journey is graded on the workout log,
    // so it belongs beside it, and its other dep (nonPartnerAttendance) is
    // already on. It is deliberately left out of this profile until the
    // app-version minimum is raised. When it is added, coachAssistant and
    // referralHomeTrigger stay out: both are off here for their own recorded
    // reasons above and are named only in the all-on/local profile.
    on: () => [
      'workoutTracking',
      'healthMetrics',
      'buddy',
      'referral',
      'badges',
      'homeTrackHome',
      'nonPartnerAttendance',
      'brandedOnboarding',
    ],
  },
};

// Declared after PROFILES because it interpolates the profile list.
const USAGE = `Usage:
  seedFeatureFlags --list
  seedFeatureFlags --profile <name> [--apply] [--note <text>] [--expect-host <substr>]
  seedFeatureFlags --set <flag>=<on|off>[,...] [--apply] [--note <text>] [--expect-host <substr>]

Profiles:
${Object.keys(PROFILES)
  .map((name) => `  ${name.padEnd(16)} ${PROFILES[name].summary}`)
  .join('\n')}

Flags: dry run unless --apply is passed. --expect-host aborts unless the
DATABASE_URL host contains the given substring (use it to make a prod write
impossible to perform by accident).`;

function parseArgs(argv) {
  const args = { apply: false, profile: null, set: null, list: false, note: null, expectHost: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`--${arg.replace(/^--/, '')} needs a value`, 2);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case '--apply': args.apply = true; break;
      case '--list': args.list = true; break;
      case '--json': args.json = true; break;
      case '--profile': args.profile = next(); break;
      case '--set': args.set = next(); break;
      case '--note': args.note = next(); break;
      case '--expect-host': args.expectHost = next(); break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown argument "${arg}"\n\n${USAGE}`, 2);
    }
  }
  return args;
}

function fail(message, code = 1) {
  console.error(`seedFeatureFlags: ${message}`);
  process.exit(code);
}

/** `--set a=on,b=off` -> a sparse override map. Rejects anything unparseable. */
function parseSet(spec) {
  const overrides = {};
  for (const pair of spec.split(',')) {
    const match = pair.match(/^(\w+)=(on|off|true|false|1|0)$/);
    if (!match) fail(`--set expects flag=on|off, got "${pair}"`, 2);
    const [, name, value] = match;
    if (!flagNames().includes(name)) {
      fail(
        `unknown flag "${name}". Not in the registry, so no gate reads it and it would be silently inert.\n` +
          `Known flags: ${flagNames().join(', ')}`,
        2
      );
    }
    overrides[name] = ['on', 'true', '1'].includes(value);
  }
  if (!Object.keys(overrides).length) fail('--set needs at least one flag=on|off', 2);
  return overrides;
}

/**
 * Resolve what the profile/set asks for into a FULL features blob.
 *
 * Full, not sparse, because the write is a whole-blob replace: the row holds
 * versions + features + maintenance in one JSON column, and `features` is the
 * only part this script owns. Anything omitted here would be erased rather than
 * left alone, so every flag is always emitted explicitly.
 */
function resolveTargetFeatures(args) {
  let on;
  if (args.set) {
    const overrides = parseSet(args.set);
    // Start from what is stored, so `--set badges=off` changes only badges. The
    // stored value is passed in by the caller.
    return { overrides };
  }
  const profile = PROFILES[args.profile];
  if (!profile) {
    fail(`unknown profile "${args.profile}". Known: ${Object.keys(PROFILES).join(', ')}`, 2);
  }
  on = profile.on();
  const unknown = on.filter((n) => !flagNames().includes(n));
  if (unknown.length) fail(`profile "${args.profile}" names unknown flag(s): ${unknown.join(', ')}`, 2);
  return {
    full: Object.fromEntries(flagNames().map((name) => [name, { enabled: on.includes(name) }])),
    on,
  };
}

function renderPlan({ target, storedFeatures, profileLabel }) {
  const before = storedFeatures || {};
  const rows = flagNames().map((name) => {
    const from = !!before[name]?.enabled;
    const to = !!target[name]?.enabled;
    const state = from === to ? '  =' : to ? ' OFF->ON' : ' ON ->OFF';
    const dep = FEATURE_FLAGS.find((f) => f.name === name)?.deps || [];
    const blocked = dep.filter((d) => !target[d]?.enabled);
    return { name, from, to, state: state.trim(), blocked };
  });
  const width = Math.max(...rows.map((r) => r.name.length));
  const lines = rows.map(
    (r) =>
      `  ${r.state.padEnd(9)} ${r.name.padEnd(width)}` +
      (r.blocked.length ? `   (inert: ${r.blocked.join(', ')} off)` : '')
  );
  const changed = diffChangedFlags(before, target);
  const newlyOn = rows.filter((r) => !r.from && r.to).map((r) => r.name);
  const newlyOff = rows.filter((r) => r.from && !r.to).map((r) => r.name);

  return { lines, changed, newlyOn, newlyOff, text: lines.join('\n'), profileLabel };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    if (args.profile || args.set) fail('--list cannot be combined with --profile/--set', 2);
    console.log('Registry flags (source of truth for every name this script accepts):\n');
    const width = Math.max(...FEATURE_FLAGS.map((f) => f.name.length));
    for (const flag of FEATURE_FLAGS) {
      console.log(
        `  ${String(flag.defaultEnabled ? 'on ' : 'off').padEnd(4)} ${flag.name.padEnd(width)}` +
          `${flag.deps.length ? `  (deps: ${flag.deps.join(', ')})` : ''}`
      );
    }
    console.log(`\n${FEATURE_FLAGS.length} flags. schemaVersion is served from the registry.`);
    console.log('\nProfiles:');
    for (const [name, profile] of Object.entries(PROFILES)) {
      console.log(`  ${name.padEnd(16)} ${profile.summary}`);
    }
    return;
  }

  if (!args.profile && !args.set) fail(`choose one of --profile / --set / --list\n\n${USAGE}`, 2);
  if (args.profile && args.set) fail('--profile and --set are mutually exclusive', 2);

  // Resolve the arguments BEFORE touching the database. A mistyped flag name or
  // profile is a usage error, and it should say so whether or not a connection
  // string happens to be present in the environment - otherwise the error an
  // operator sees depends on their shell, not on their mistake.
  const resolved = resolveTargetFeatures(args);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail('DATABASE_URL is not set - load the service .env, or export it. Refusing to guess a database.');
  }
  const host = (() => {
    try {
      return new URL(databaseUrl).host;
    } catch {
      return '(unparseable DATABASE_URL host)';
    }
  })();

  // The prod guard. Not a heuristic about whether this "looks like" prod - a
  // wrong guess either blocks a legitimate write or waves through a dangerous
  // one. Instead the caller states the host it believes it is talking to, and a
  // mismatch is a hard stop.
  if (args.expectHost && !host.includes(args.expectHost)) {
    fail(`--expect-host ${args.expectHost} does not match the DATABASE_URL host "${host}". Refusing to write.`);
  }

  const prisma = new PrismaClient();

  try {
    const row = await prisma.appVersionSetting.findUnique({ where: { id: 1 } });
    const config = row?.config || {};
    const storedFeatures = config.features || {};

    let target;
    let profileLabel;
    if (resolved.overrides) {
      // Merge onto stored state, and keep any key the registry does not know
      // about: a flag written by a newer auth-service must survive an operator
      // running this script, exactly as it survives a portal save.
      target = { ...structuredClone(storedFeatures) };
      for (const [name, enabled] of Object.entries(resolved.overrides)) {
        target[name] = { enabled };
      }
      profileLabel = `--set ${Object.entries(resolved.overrides).map(([n, v]) => `${n}=${v}`).join(',')}`;
    } else {
      target = resolved.full;
      profileLabel = `--profile ${args.profile} (${resolved.on.length} on)`;
    }

    const plan = renderPlan({ target, storedFeatures, profileLabel });

    if (args.json) {
      console.log(JSON.stringify({ dryRun: !args.apply, host, profile: profileLabel, changed: plan.changed, target }, null, 2));
    } else {
      console.log(`Target database host: ${host}`);
      console.log(`Profile:             ${profileLabel}`);
      console.log(`Stored flags:        ${Object.keys(storedFeatures).length}   Target: ${flagNames().length}`);
      console.log('');
      console.log('  change     flag');
      console.log(plan.text);
      console.log('');
      console.log(
        plan.changed.length
          ? `${plan.changed.length} flag(s) change: ${plan.newlyOn.length} on, ${plan.newlyOff.length} off`
          : 'No change - stored state already matches.'
      );
    }

    if (!args.apply) {
      console.log('\nDry run. Nothing was written. Re-run with --apply to make this change.');
      return;
    }

    if (!plan.changed.length) {
      console.log('\nNothing to do.');
      return;
    }

    // Validate through the same function the admin route uses, so this script
    // cannot write a payload the API would have rejected - and, more to the
    // point, cannot drift from what the API accepts.
    const { unknown, malformed } = validateFeaturePayload(target);
    if (unknown.length) fail(`refusing to write unknown flag(s): ${unknown.join(', ')}`);
    if (malformed.length) fail(`refusing to write malformed flag(s): ${malformed.join(', ')}`);

    const note = args.note || `seedFeatureFlags ${profileLabel}`;
    // Read-modify-write: versions and maintenance share this column with
    // features, and replacing the whole object would drop the force-update
    // minimums and any maintenance window.
    await prisma.$transaction([
      prisma.appVersionSetting.upsert({
        where: { id: 1 },
        create: { id: 1, config: { ...config, features: target }, updatedBy: null },
        update: { config: { ...config, features: target }, updatedBy: null },
      }),
      // Same audit row the portal writes, so "who switched this on" has one
      // answer whether it came from the UI or from this script. updatedBy is
      // null because there is no user behind a CLI invocation - the note is
      // what identifies it.
      prisma.appConfigHistory.create({
        data: { changedFlags: plan.changed, before: storedFeatures, after: target, note, changedBy: null },
      }),
    ]);

    console.log(`\nWrote ${plan.changed.length} flag(s): ${plan.changed.join(', ')}`);
    console.log(`Audit note: ${note}`);
    console.log('Note: gates in other services cache /app-config for 30s, so enforcement lags a little.');
  } catch (err) {
    fail(err.message || String(err));
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked as a command. Without this guard, importing the module
// (as the profile tests do) would execute the CLI against whatever
// DATABASE_URL happens to be in the environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(err?.stack || String(err)));
}
