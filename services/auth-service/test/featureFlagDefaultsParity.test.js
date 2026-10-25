import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { FEATURE_FLAGS } from '../config/featureFlagRegistry.js';

// The offline fallback and the server defaults answer the same question - "the
// app has no config yet, what is on?" - from two files that were never compared.
// `AppConfigModel.notRequired()` is what every screen reads before the first
// successful fetch, and a divergence there is invisible until someone is
// offline on a train and sees a feature the server would have refused.
//
// This parses the Dart rather than running it: the client is a separate repo and
// cannot import the registry, which is the same constraint the contract test in
// featureFlagRegistry.test.js works under.

const here = dirname(fileURLToPath(import.meta.url));
const reposRoot = join(here, '..', '..', '..', '..');
// The app checkout to compare against. Defaults to the sibling repo, but
// CUSTOMER_APP_DIR overrides it so the test can run against a specific (e.g.
// clean) checkout; a relative value is resolved from the cwd of the test run,
// so `../../../pg-app-clean` works from this service directory.
const customerAppDir = process.env.CUSTOMER_APP_DIR
  ? resolve(process.env.CUSTOMER_APP_DIR)
  : join(reposRoot, 'phool-gobhi-customer-app');
const customerAppModel = join(
  customerAppDir,
  'lib',
  'data',
  'models',
  'app_config_model.dart',
);
const customerAppCubit = join(
  customerAppDir,
  'lib',
  'presentation',
  'bloc',
  'app_update',
  'app_update_cubit.dart',
);

function readDartNotRequired() {
  if (!existsSync(customerAppModel)) return null;
  const dart = readFileSync(customerAppModel, 'utf8');
  const start = dart.indexOf('AppConfigModel.notRequired()');
  if (start === -1) throw new Error('AppConfigModel.notRequired() not found');

  // The factory is `=> AppConfigModel( ... );` with literal arguments, not a
  // block, so slice to the closing paren rather than walking braces. The
  // constructor further down repeats every name as `required this.x`, so
  // bounding the slice is what keeps those out of the defaults.
  const end = dart.indexOf(');', start);
  if (end === -1) throw new Error('could not find the end of notRequired()');
  const body = dart.slice(start, end);

  // Keyed by clientKey, because that is the name the registry declares and the
  // name in the Dart - deriving the flag name by stripping "Enabled" would
  // break on any flag whose clientKey is not exactly that.
  const found = new Map();
  for (const m of body.matchAll(/(\w+Enabled):\s*(true|false)\s*,/g)) {
    found.set(m[1], m[2] === 'true');
  }
  return found;
}

test('the offline fallback matches the server defaults for every flag', (t) => {
  const dart = readNotRequiredOrSkip(t);
  if (!dart) return;

  const divergence = [];
  for (const flag of FEATURE_FLAGS) {
    if (!flag.clientKey) continue; // fhirExport; the contract test pins that it is the only one
    const clientKey = flag.clientKey;
    const clientDefault = dart.get(clientKey);
    if (clientDefault === undefined) {
      divergence.push(`${flag.name}: server=${flag.defaultEnabled}, client has no notRequired() entry`);
    } else if (clientDefault !== flag.defaultEnabled) {
      divergence.push(`${flag.name}: server=${flag.defaultEnabled}, client=${clientDefault}`);
    }
  }
  assert.deepEqual(
    divergence,
    [],
    'offline fallback disagrees with the registry default - a screen can show a feature the server would 403',
  );
});

function readNotRequiredOrSkip(t) {
  const dart = readDartNotRequired();
  if (!dart) {
    t.skip('customer app not present (backend-only checkout) - offline fallback is unverified');
    return null;
  }
  return dart;
}

test('every client flag with a clientKey appears in notRequired()', (t) => {
  const dart = readNotRequiredOrSkip(t);
  if (!dart) return;
  const missing = FEATURE_FLAGS.filter((f) => f.clientKey)
    .map((f) => f.clientKey)
    .filter((k) => !dart.has(k))
    .sort();
  assert.deepEqual(
    missing,
    [],
    'these flags have a client field but no offline fallback, so the app cannot tell "off" from "not loaded yet"',
  );
});

test('the client resolves a missing key the same way the registry defaults it', (t) => {
  // The same divergence by the other route: `fromJson` supplies its own `??`
  // per field, so a config that omits a key entirely resolves it there, not via
  // the registry. Assert the two client paths agree with each other as well as
  // with the server, or the app behaves differently depending on whether the
  // server omitted a key or sent it as false.
  if (!existsSync(customerAppModel)) {
    t.skip('customer app not present (backend-only checkout)');
    return;
  }
  const dart = readFileSync(customerAppModel, 'utf8');
  const notRequired = readDartNotRequired();

  // `<clientKey>: <local>['enabled'] as bool? ?? <default>,`
  const fromJson = new Map();
  for (const m of dart.matchAll(/(\w+Enabled):\s*\w+\['enabled'\]\s+as\s+bool\?\s*\?\?\s*(true|false)\s*,?/g)) {
    fromJson.set(m[1], m[2] === 'true');
  }
  // Strict equality is another fail-closed decoder: a missing/null key can
  // never equal true. Preserve the same comparison against registry defaults.
  for (const m of dart.matchAll(/(\w+Enabled):\s*\w+\['enabled'\]\s*==\s*true\s*,/g)) {
    fromJson.set(m[1], false);
  }

  const divergence = [];
  for (const flag of FEATURE_FLAGS) {
    if (!flag.clientKey) continue;
    const key = flag.clientKey;
    const nj = notRequired.get(key);
    const fj = fromJson.get(key);
    if (fj === undefined) {
      divergence.push(`${flag.name}: fromJson has no \`?? <default>\` fallback`);
    } else if (nj !== undefined && fj !== nj) {
      divergence.push(`${flag.name}: fromJson=${fj} but notRequired=${nj}`);
    } else if (fj !== flag.defaultEnabled) {
      divergence.push(`${flag.name}: fromJson=${fj} but registry default=${flag.defaultEnabled}`);
    }
  }
  assert.deepEqual(
    divergence,
    [],
    'the two client fallback paths disagree, or disagree with the registry',
  );
});

// The third fallback, and the one that actually reaches the user first.
//
// AppUpdateCubit holds the flag fields directly (widgets read
// `context.read<AppUpdateCubit>().workoutTrackingEnabled`), and their initial
// values are what every surface renders during startup and forever after if the
// app-config call fails. So a flag can agree with the registry in
// AppConfigModel and still fail open in the cubit - which is exactly what
// happened to badges: the model and the registry both said false while the
// cubit said true, so badges showed for the whole pre-fetch window and on every
// config failure. Two paths agreeing is not evidence about the third.
test('the cubit pre-fetch defaults match the registry too', (t) => {
  if (!existsSync(customerAppCubit)) {
    t.skip('customer app not present (backend-only checkout)');
    return;
  }
  const dart = readFileSync(customerAppCubit, 'utf8');

  // Field declarations look like `  bool xEnabled = false;`. The later
  // assignments that apply the resolved config (`xEnabled = config.xEnabled;`)
  // have no type prefix, so anchoring on `bool` excludes them - which is what we
  // want, since the point is the value the app starts with.
  const cubitDefaults = new Map();
  for (const m of dart.matchAll(/^\s+bool\s+(\w+)\s*=\s*(true|false)\s*;/gm)) {
    cubitDefaults.set(m[1], m[2] === 'true');
  }

  // Current cubits delegate to the one store rather than duplicating flags.
  // Follow that exact fallback chain, then compare the model's parsed literal
  // values below; a renamed getter or a different fallback must still fail.
  const delegated = [...dart.matchAll(/bool\s+get\s+(\w+)\s*=>\s*_config\.(\w+)\s*;/g)];
  if (delegated.length) {
    assert.match(dart, /_failClosed\s*=\s*AppConfigModel\.notRequired\(\)/);
    assert.match(dart, /AppConfigModel\s+get\s+_config\s*=>\s*_store\.config\s*\?\?\s*_failClosed/);
    const fallback = readDartNotRequired();
    assert.ok(fallback, 'cannot resolve the delegated model fallback');
    for (const [, key, property] of delegated) {
      assert.equal(key, property, 'a cubit flag delegates to a different model property');
      assert.ok(fallback.has(property), `missing model fallback for ${property}`);
      cubitDefaults.set(key, fallback.get(property));
    }
  }

  assert.ok(cubitDefaults.size > 0, 'found no bool flag fields in the cubit');

  // Flags the cubit deliberately does not carry. Each is read straight off
  // AppConfigStore by the widgets that need it (app_config_store.dart's
  // healthLedgerVisible / foodPhotoLoggingVisible / coachJourneyVisible /
  // selfLinkGymVisible), where the getter can fold in a parent flag - the ledger
  // gate also has to account for healthMetrics, and food-photo logging and the
  // coach-journey / self-link surfaces have no home-screen cubit field. The last
  // two - referralHomeTrigger and coachAssistant - have no client reader at all
  // yet: they exist in AppConfigModel only and default false, so they fail
  // closed. Listed rather than skipped so a genuinely dropped flag is noticed.
  const readFromTheStore = new Set([
    'healthLedgerEnabled',
    'foodPhotoLoggingEnabled',
    'coachJourneyEnabled',
    'selfLinkGymEnabled',
    'referralHomeTriggerEnabled',
    'coachAssistantEnabled',
    'exploreFoodFindsEnabled',
  ]);

  const divergence = [];
  const missing = [];
  for (const flag of FEATURE_FLAGS) {
    if (!flag.clientKey) continue; // fhirExport; server-only by design
    const key = flag.clientKey;
    if (readFromTheStore.has(key)) continue;
    if (!cubitDefaults.has(key)) {
      missing.push(key);
    } else if (cubitDefaults.get(key) !== flag.defaultEnabled) {
      divergence.push(`${flag.name}: server=${flag.defaultEnabled}, cubit=${cubitDefaults.get(key)}`);
    }
  }

  assert.deepEqual(missing, [], 'flags with a clientKey that the cubit no longer exposes');
  assert.deepEqual(
    divergence,
    [],
    'a flag fails open or closed in the cubit differently from the registry - '
      + 'the app shows that feature from startup until the config call resolves, '
      + 'and forever if that call fails',
  );
});

