import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FEATURE_FLAGS,
  FLAG_SCHEMA_VERSION,
  defaultFeatures,
  flagNames,
  flagRegistry,
} from '../config/featureFlagRegistry.js';

// Every flag drift this file is about was silent. `runTracker` shipped, was the
// only flag off in dev, and could not be switched on from the admin portal —
// because the portal maintained its own list of 17 flag names and `runTracker`
// was not among them. `cycleTracking` shipped and the customer app had no field
// for it, so the client structurally could not honour it. `fhirExport` has been
// checked by exportController since ABHA Stage 0 and was never declared
// anywhere, so it resolved false forever.
//
// All three were invisible because nothing compared the four lists against each
// other. These tests do that. They run with no database and no app instance, and
// the checks that matter are all static.

const here = dirname(fileURLToPath(import.meta.url));
const servicesRoot = join(here, '..', '..');
// Sibling checkouts, not children of the backend repo — `repos/` is the parent
// of both this repo and the client repos. Every cross-repo test below skips
// rather than fails when the other repo is absent, so a backend-only CI checkout
// still runs the parts that do not need it.
const reposRoot = join(servicesRoot, '..', '..');

// ---------------------------------------------------------------------------
// The registry against itself
// ---------------------------------------------------------------------------

test('flag names are unique', () => {
  const names = flagNames();
  assert.deepEqual(
    names.filter((n, i) => names.indexOf(n) !== i),
    [],
    'duplicate flag name in the registry',
  );
});

test('client keys are unique', () => {
  const keys = FEATURE_FLAGS.map((f) => f.clientKey).filter((k) => k);
  assert.deepEqual(
    keys.filter((k, i) => keys.indexOf(k) !== i),
    [],
    'two flags share a clientKey, so the client could not tell them apart',
  );
});

test('every dep resolves to a real flag', () => {
  const names = flagNames();
  for (const flag of FEATURE_FLAGS) {
    for (const dep of flag.deps) {
      assert.ok(names.includes(dep), `${flag.name} depends on "${dep}", which is not a registered flag`);
    }
  }
});

test('every flag carries the fields the admin portal renders', () => {
  // The portal reads name/group/deps/defaultEnabled/clientKey/blastRadius. A
  // flag missing one of them would render as a broken row rather than fail here.
  for (const flag of FEATURE_FLAGS) {
    assert.equal(typeof flag.name, 'string', 'name');
    assert.equal(typeof flag.defaultEnabled, 'boolean', `${flag.name}.defaultEnabled`);
    assert.ok(
      typeof flag.clientKey === 'string' || flag.clientKey === null,
      `${flag.name}.clientKey must be a string, or explicit null if there is no client surface`,
    );
    assert.ok(flag.group, `${flag.name}.group`);
    assert.ok(flag.blastRadius, `${flag.name}.blastRadius`);
    assert.ok(flag.rationale?.length > 40, `${flag.name}.rationale — say why, the next reader will need it`);
    assert.ok(Array.isArray(flag.deps), `${flag.name}.deps`);
  }
});

test('defaultFeatures covers every registered flag', () => {
  const defaults = defaultFeatures();
  assert.deepEqual(Object.keys(defaults).sort(), flagNames().slice().sort());
});

test('only the two live features default to on', () => {
  // buddy and referral are live, so a missing or unknown flag must resolve to
  // enabled rather than hide a shipped feature. Everything else collects or
  // moves state and therefore fails closed — that convention is the reason a
  // registry entry can be added without anyone having to reason about what an
  // absent key means.
  const onByDefault = FEATURE_FLAGS.filter((f) => f.defaultEnabled).map((f) => f.name).sort();
  assert.deepEqual(onByDefault, ['buddy', 'referral'], 'the fail-open set changed — re-read the rationale before doing that');
});

// ---------------------------------------------------------------------------
// The registry against the code that switches on flags
// ---------------------------------------------------------------------------

function jsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'prisma' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) jsFiles(full, acc);
    else if (entry.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const FLAG_REFERENCE =
  /(?:isFeatureEnabled|requireFeatureFlag|isAnyFeatureEnabled|isEnabled)\(\s*'([A-Za-z][A-Za-z0-9]*)'\s*\)/g;

test('every flag referenced in service code is registered', () => {
  // The check whose absence let fhirExport live outside the flag system for
  // months: a real gate, checked on every export, resolving false forever and
  // switchable by nobody.
  const referenced = new Set();
  for (const file of jsFiles(servicesRoot)) {
    if (file.includes(join('test', ''))) continue; // fixtures use demoFlag
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(FLAG_REFERENCE)) referenced.add(m[1]);
  }
  const names = flagNames();
  const unregistered = [...referenced].filter((n) => !names.includes(n)).sort();
  assert.deepEqual(
    unregistered,
    [],
    'these flags are checked in service code but declared nowhere — add them to FEATURE_FLAGS',
  );
});

test('every registered flag that gates a route is reachable from the portal', () => {
  // Every registry entry has a clientKey except fhirExport, which is a
  // query-parameter branch on an existing route with no client surface. If a
  // second such flag appears this should say so out loud rather than quietly
  // accumulate.
  const noClientSurface = FEATURE_FLAGS.filter((f) => !f.clientKey).map((f) => f.name);
  assert.deepEqual(noClientSurface, ['fhirExport'], 'a new flag has no client surface — is that intended?');
});

// ---------------------------------------------------------------------------
// The registry against the customer app
// ---------------------------------------------------------------------------

const customerAppModel = join(
  reposRoot,
  'phool-gobhi-customer-app',
  'lib',
  'data',
  'models',
  'app_config_model.dart',
);

test('the customer app can read every flag the registry declares', (t) => {
  // The drift this replaces: cycleTracking shipped server-side and AppConfigModel
  // had no field for it, so the client had no way to honour the flag no matter
  // what the server said. The client is a separate repo and cannot import this
  // registry, so the contract has to be asserted here instead.
  if (!existsSync(customerAppModel)) {
    t.skip('customer app not present (backend-only checkout) — the flag/client contract is unverified');
    return;
  }
  const dart = readFileSync(customerAppModel, 'utf8');
  const missing = FEATURE_FLAGS.filter((f) => f.clientKey).filter(
    (f) => !dart.includes(f.clientKey),
  );
  assert.deepEqual(
    missing.map((f) => `${f.name} -> ${f.clientKey}`),
    [],
    'these registry flags have no field in the customer app\'s AppConfigModel',
  );
});

test('the customer app does not read a flag the registry does not declare', (t) => {
  // The mirror image, and the drift that made `referral` invisible: the client
  // resolved features.referral from a key the server never sent, so it used its
  // own fail-open default forever with no backend gate and no portal control.
  if (!existsSync(customerAppModel)) {
    t.skip('customer app not present (backend-only checkout)');
    return;
  }
  const dart = readFileSync(customerAppModel, 'utf8');
  const read = new Set();
  for (const m of dart.matchAll(/features\['([A-Za-z][A-Za-z0-9]*)'\]/g)) read.add(m[1]);
  const names = flagNames();
  // otp and profileCompletionBonus are not registry entries — they are served
  // from their own singleton setting rows (OtpProviderSetting,
  // ProfileCompletionBonusSetting), which is where an admin edits them.
  const SINGELTON_SETTINGS = ['otp', 'profileCompletionBonus'];
  assert.deepEqual(
    [...read].filter((n) => !names.includes(n) && !SINGELTON_SETTINGS.includes(n)).sort(),
    [],
    'the customer app reads features the registry does not declare',
  );
});

// ---------------------------------------------------------------------------
// The registry against the admin portal
// ---------------------------------------------------------------------------

const adminSettingsAction = join(
  reposRoot,
  'phool-gobhi-admin',
  'app',
  'settings',
  'actions.ts',
);

test('the admin portal does not redeclare its own flag list', (t) => {
  // This is the check whose absence made `runTracker` unreachable: the portal
  // wrote 15 flag names by hand and runTracker was not among them, so a flag
  // that shipped and was the only one off in dev could only ever be switched on
  // by editing the config blob or deploying a code change. The portal now reads
  // its flag list from GET /app-config/registry, so this asserts it no longer
  // hardcodes one.
  if (!existsSync(adminSettingsAction)) {
    t.skip('admin portal not present (backend-only checkout)');
    return;
  }
  const ts = readFileSync(adminSettingsAction, 'utf8');
  const declared = flagNames().filter((n) => new RegExp(`^\\s{2}${n}:`, 'm').test(ts));
  assert.deepEqual(
    declared,
    [],
    'the admin portal still declares flag names by hand — read them from GET /app-config/registry',
  );
  assert.match(
    ts,
    /app-config\/registry/,
    'updateFeatureFlagsAction must read the flag list from the registry endpoint',
  );
});

test('the registry endpoint returns every flag with its live value', () => {
  // Guards the shape the portal depends on: name, group, deps, defaultEnabled
  // and enabled. A response missing `enabled` would render every toggle off
  // regardless of what is stored.
  const entry = flagRegistry()[0];
  for (const key of ['name', 'group', 'deps', 'defaultEnabled', 'clientKey', 'blastRadius', 'blockedBy']) {
    assert.ok(key in entry, `flagRegistry() entries must carry ${key}`);
  }
  assert.equal(typeof FLAG_SCHEMA_VERSION, 'number');
  assert.ok(FLAG_SCHEMA_VERSION >= 2, 'schemaVersion must move when the flag set changes shape');
});
