import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// On 2026-10-04 the single `healthMetrics` boolean was split into a standalone
// workout log (`workoutTracking`) and a narrowed derived-score layer
// (`healthMetrics`), plus a standalone Local Health Vault (`healthVault`).
//
// The failure mode this guards against is specific and nasty: a route left on
// the old gate is not obviously wrong. `healthMetrics` still exists and still
// gates a real, shipping feature, so a workout route that stayed on it keeps
// returning 200 for every user whose admin happens to have healthMetrics on —
// and only starts 403ing for the person who most wanted to test turning
// workout tracking off. Nothing fails, no test fails, and the split silently
// does not split.
//
// So the routing table is checked as a MATRIX, not route by route: for each
// surface, which of the three gates it must be on, and — just as important —
// which gates it must NOT be on. A route silently moved from workoutGated to
// metricsGated is the exact bug, and a test that only asserted "this route is
// on some gate" would not see it.
//
// Textual, like ledgerRoutingGates.test.js, for the same reasons: it runs with no
// database and no app instance, and it fails the moment the table changes shape.

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, '..', 'routes', 'health.js'), 'utf8');

// Whole statements, not lines: several routes here are multi-line router
// declarations, and a line-based scan loses the path so the route cannot be
// matched against the matrix at all.
function routeStatements() {
  const out = [];
  const lines = routes.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^router\.(get|post|put|patch|delete)\(/.test(lines[i].trim())) continue;
    const start = i;
    let stmt = lines[i];
    let depth =
      (stmt.match(/\(/g) || []).length - (stmt.match(/\)/g) || []).length;
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      stmt += `\n${lines[i]}`;
      depth +=
        (lines[i].match(/\(/g) || []).length - (lines[i].match(/\)/g) || []).length;
    }
    out.push({ line: stmt.replace(/\s+/g, ' ').trim(), n: start + 1 });
  }
  return out;
}

const all = routeStatements();

function routesMatching(fragment) {
  const found = all.filter((r) => r.line.includes(fragment));
  assert.ok(found.length, `no route found for "${fragment}"`);
  return found;
}

// Asserts a set of routes sits on exactly one gate array, and on no other.
// "Exactly" is the load-bearing word: the negative half is what catches a route
// migrated to the wrong half of the split.
function assertGate(fragment, gate, forbidden = []) {
  for (const r of routesMatching(fragment)) {
    assert.match(
      r.line,
      new RegExp(`\\.\\.\\.${gate}\\b`),
      `${r.n}: ${r.line} is not on ${gate}`,
    );
    for (const other of forbidden) {
      assert.doesNotMatch(
        r.line,
        new RegExp(`\\.\\.\\.${other}\\b`),
        `${r.n}: ${r.line} must NOT be on ${other} — this is the split not splitting`,
      );
    }
  }
}

// ---- The workout half -----------------------------------------------------
// Everything derived from what someone physically trained. This is the
// high-frequency daily loop and the reason the split exists: it must not be
// switched by a decision about health scores.

test('the exercise library and routines are on the workout gate only', () => {
  assertGate("'/exercises'", 'workoutGated', ['metricsGated', 'vaultGated']);
  assertGate("'/templates'", 'workoutGated', ['metricsGated', 'vaultGated']);
});

test('workout sessions are on the workout gate only', () => {
  assertGate("'/sessions'", 'workoutGated', ['metricsGated', 'vaultGated']);
  // The completion side is what mints coins and prompts the check-in nudge, so
  // it is the half most likely to have been left on the old gate by accident.
  assertGate("'/progress/", 'workoutGated', ['metricsGated', 'vaultGated']);
  assertGate("'/suggestions/impressions'", 'workoutGated', ['metricsGated', 'vaultGated']);
});

test('quick logging, cardio sync, plans, goals and home-track streaks are workout-gated', () => {
  // Each of these is a training-data surface. None of them reads a health score,
  // and none of them should disappear because someone turned healthMetrics off.
  for (const prefix of [
    "'/exercise-records'",
    "'/daily-activity",
    "'/plans'",
    "'/goal'",
    "'/consistency-streak'",
    "'/stats'",
    "'/unlogged'",
    "'/nudges'",
  ]) {
    assertGate(prefix, 'workoutGated', ['metricsGated', 'vaultGated']);
  }
  assertGate("'/insurer-grade'", 'workoutGated', ['metricsGated', 'vaultGated']);
});

test('the workout gate is the transitional either-flag, not a plain flag check', () => {
  // If this ever becomes requireFeatureFlag('workoutTracking') while stored
  // config blobs still lack the key, every workout route 403s for every
  // existing user. That tightening belongs to the backfill commit, not here.
  const decl = routes.match(/const workoutGated = \[([^\]]*)\]/)?.[1] || '';
  assert.match(
    decl,
    /requireAnyFeatureFlag\('workoutTracking', 'healthMetrics'\)/,
    'workoutGated must accept either flag during the transition window',
  );
});

// ---- The metrics half -----------------------------------------------------
// The derived-score layer. Narrowed, but still gated on healthMetrics alone —
// the registry's dependency on workoutTracking is not yet enforced here.

test('biometric data routes are on the metrics gate only', () => {
  // Scoped to the data routes, NOT '/biometrics/consent' — the DELETE on that
  // path is deliberately ungated and asserted below, so a bare '/biometrics'
  // prefix match would contradict it.
  for (const r of routesMatching("'/biometrics").filter(
    (r) => !r.line.includes('/consent'),
  )) {
    assert.match(
      r.line,
      /\.\.\.metricsGated\b/,
      `${r.n}: ${r.line} is not on metricsGated`,
    );
    assert.doesNotMatch(
      r.line,
      /\.\.\.(workoutGated|vaultGated)\b/,
      `${r.n}: ${r.line} must NOT be on the workout or vault gate`,
    );
  }
  assertGate("'/retention-policy'", 'metricsGated', ['workoutGated', 'vaultGated']);
});

test('the metrics gate is healthMetrics alone — the workout dependency is not yet enforced', () => {
  // Pins the transitional state described at the metricsGated declaration. When
  // the backfill lands, this test is EXPECTED to fail and the array is expected
  // to gain requireFeatureFlag('workoutTracking') in the same commit. That is
  // deliberate: the failure is the reminder, and flipping the expectation at the
  // same time as the code is how the dependency stops being invisible.
  const decl = routes.match(/const metricsGated = \[([^\]]*)\]/)?.[1] || '';
  assert.match(decl, /requireFeatureFlag\('healthMetrics'\)/);
  assert.doesNotMatch(
    decl,
    /requireFeatureFlag\('workoutTracking'\)/,
    'metricsGated tightened before the backfill — every score route 403s on un-backfilled configs',
  );
});

// ---- The vault ------------------------------------------------------------
// The most consent-sensitive surface in the app, and the one the old shared
// boolean got most wrong. It depends on nothing.

test('report upload, pending extractions and verification are on the vault gate only', () => {
  assertGate("'/reports/upload'", 'vaultGated', ['workoutGated', 'metricsGated']);
  assertGate("'/reports/pending'", 'vaultGated', ['workoutGated', 'metricsGated']);
  assertGate("'/reports/verify'", 'vaultGated', ['workoutGated', 'metricsGated']);
});

test('the vault gate depends on no other flag', () => {
  // Reading back a report a user uploaded while the vault was on must survive
  // the vault being switched off — hence not layered on healthMetrics or
  // workoutTracking. See the declaration comment.
  const decl = routes.match(/const vaultGated = \[([^\]]*)\]/)?.[1] || '';
  assert.match(decl, /requireFeatureFlag\('healthVault'\)/);
  assert.doesNotMatch(
    decl,
    /workoutTracking|healthMetrics/,
    'the vault must not inherit another feature\'s gate',
  );
});

// ---- The transitional surfaces -------------------------------------------
// Two surfaces that legitimately span both halves, plus the access right.

test('consent endpoints accept either flag — neither half may lock out its own consent record', () => {
  // The device-health scope backs workout sync; the body-numbers scope backs
  // biometrics. Gating on one half would leave the other unable to read or
  // withdraw its own consent.
  const decl = routes.match(/const consentGated = \[([^\]]*)\]/)?.[1] || '';
  assert.match(
    decl,
    /requireAnyFeatureFlag\('workoutTracking', 'healthMetrics'\)/,
    'consent must be reachable under either half of the split',
  );
  for (const r of routesMatching("'/consent'").concat(routesMatching("'/consent/status'"))) {
    assert.match(r.line, /\.\.\.consentGated\b/, `${r.n}: ${r.line} is not on consentGated`);
  }
});

test('the DPDPA export accepts either flag — an access right may not fail closed on a feature switch', () => {
  // After the split a user can have workout sessions logged with healthMetrics
  // off. Gating export on the score layer would strand exactly that user's own
  // data behind a switch they cannot reach.
  const decl = routes.match(/const exportGated = \[([^\]]*)\]/)?.[1] || '';
  assert.match(
    decl,
    /requireAnyFeatureFlag\('workoutTracking', 'healthMetrics'\)/,
    'export must span both halves of the split',
  );
});

// ---- Deletion must never be stranded --------------------------------------
// The most important invariant in this file, and the one most easily broken by
// a well-meaning "make it consistent" edit during a refactor like this one.
//
// Named explicitly rather than pattern-matched. Not every DELETE here is
// ungated — consent withdrawal for cycle tracking and the assistant IS still
// flag-gated — and a sweep asserting "all deletes ungated" would be wrong. The
// set below is the one that must not be: outright erasure of data a user
// collected, plus the consent revokes the router file calls out as ungated.
// The distinction is deliberate — withdrawing consent is a narrower act than
// erasing, and those routes are gated on the flag that makes consent meaningful.

const MUST_STAY_UNGATED = [
  // Account-wide, both directions.
  "router.delete('/me'",
  // Full erase of a feature's data. Not even flag-aware.
  "router.delete('/cycle'",
  // A recorded route is a precise location history; erasing it cannot depend on
  // runTracker still being on.
  "router.delete('/runs/:id'",
  // Consent revokes the file explicitly calls requireAuth-only, so that
  // withdrawing cannot be what strands data.
  "router.delete('/runs/consent'",
  "router.delete('/biometrics/consent'",
  // Seeing and erasing your own onboarding answers can never depend on a
  // feature switch — these run at signup, for every user, while the flags are
  // mostly off.
  "router.delete('/health-profile'",
  "router.delete('/health-profile/consent'",
  "router.delete('/health-profile/medications/:id'",
  // A lab report the user uploaded to the health vault, and the extracted
  // biomarkers hanging off it. Both directions of the vault's own argument apply
  // at once: the data is the most sensitive thing this service holds, and the
  // vault flag is not the user's to control. It is also the flag most likely to
  // be flipped off — the vault is default-off pending legal sign-off — which is
  // precisely when a user deleting an unwanted lab report must still be able to.
  "router.delete('/reports/:id'",
];

test('data erasure stays reachable with requireAuth alone, whatever the flags say', () => {
  for (const prefix of MUST_STAY_UNGATED) {
    const found = all.find((r) => r.line.startsWith(prefix));
    assert.ok(found, `no route found for ${prefix}`);
    assert.match(
      found.line,
      /\brequireAuth\b/,
      `${found.n}: ${found.line} must stay reachable so a user can erase their own data`,
    );
    assert.doesNotMatch(
      found.line,
      /\.\.\.[a-zA-Z]+Gated\b/,
      `${found.n}: ${found.line} is flag-gated — withdrawing consent must never be what strands data`,
    );
  }
});

test('and the rest of the delete surface is accounted for rather than unlisted', () => {
  // The complement of the set above, so a new DELETE cannot land here ungated by
  // omission. Every remaining delete is a consent withdrawal behind its
  // feature's own flag, which is the intended shape.
  const ungatedDeletes = all
    .filter((r) => r.line.startsWith('router.delete('))
    .filter((r) => !MUST_STAY_UNGATED.some((p) => r.line.startsWith(p)))
    .map((r) => r.line.replace(/\s+/g, ' '))
    // Sorted so the comparison is set equality: the whole point of this test is
    // that no delete is unaccounted for, which is a question about the SET, not
    // about where each route happens to be declared in the file.
    .sort();

  assert.deepEqual(
    ungatedDeletes,
    [
      // Consent withdrawals, each behind the flag that makes the consent
      // meaningful.
      "router.delete('/cycle/consent', ...cycleGated, cycleCtrl.revokeConsent);",
      "router.delete('/consent', ...consentGated, consentCtrl.revokeConsent);",
      "router.delete('/assistant/consent', ...assistantGated, assistantCtrl.revokeConsent);",
      // Deleting one's own assistant conversation or a memory the assistant
      // wrote about the user. Flag-gated with the rest of the assistant, unlike
      // the vault and cycle routes above: an assistant memory is derived from
      // the training log, so it is the workout half's to strand, and it still
      // leaves under /me erasure.
      "router.delete('/assistant/conversations/:id', ...assistantGated, assistantCtrl.deleteConversation);",
      "router.delete('/assistant/memories/:id', ...assistantGated, assistantCtrl.forgetMemory);",
      // Flag-gated but NOT consent-scope-gated, which is the distinction the
      // router file draws: deleting a logged value must never require agreeing
      // to log more. These were the two I initially left out of this list.
      "router.delete('/biometrics/:metric/:localDate', ...metricsGated, biometricCtrl.deleteEntry);",
      "router.delete('/templates/:id', ...workoutGated, templateCtrl.deleteTemplate);",
      "router.delete('/plans/active', ...workoutGated, planCtrl.abandonPlan);",
    ].sort(),
    'a delete route is neither in the ungated erasure set nor a recognised consent withdrawal',
  );
});

// ---- Structural invariants ------------------------------------------------

test('every gate array authenticates before it checks a flag', () => {
  // Guards against a future edit reordering these into a bare flag check, which
  // would let an unauthenticated caller probe which flags are on.
  for (const name of [
    'workoutGated',
    'metricsGated',
    'vaultGated',
    'consentGated',
    'exportGated',
    'personalisationGated',
    'recapGated',
    'assistantGated',
    'runTrackerGated',
    'cycleGated',
    'profileWrite',
  ]) {
    const decl = routes.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1] || '';
    assert.ok(decl, `${name} is not declared`);
    assert.ok(
      decl.trimStart().startsWith('requireAuth'),
      `${name} must start with requireAuth — a flag check before auth leaks flag state`,
    );
  }
});

test('every customer-facing route is behind some gate or internal auth', () => {
  // The sweep. /reports/* are inline-spread from vaultGated rather than
  // declared before a named array, and the internal/* and admin/* routes
  // authenticate differently, so both are accounted for explicitly.
  const ungated = all.filter(
    (r) =>
      !/\.\.\.(workoutGated|metricsGated|vaultGated|consentGated|exportGated|personalisationGated|recapGated|assistantGated|runTrackerGated|cycleGated|profileWrite)\b/.test(r.line) &&
      !/^router\.\w+\('\/reports\//.test(r.line) &&
      !/\brequireInternal\b/.test(r.line) &&
      !/requireRole\('gobhi'\)/.test(r.line) &&
      !/\brequireAuth\b/.test(r.line),
  );
  assert.deepEqual(
    ungated.map((r) => `${r.n}: ${r.line}`),
    [],
    'a route has no feature gate and no auth',
  );
});

test('the internal attendance fan-in checks the workout flag in the handler, not the route', () => {
  // booking-service calls this unconditionally on every verified check-in, so
  // flag-gating the route would turn an admin's decision into a 403 in another
  // service's logs. The handler is where the check belongs.
  const route = all.find((r) => r.line.includes('/internal/attendance-events'));
  assert.ok(route, 'no attendance-events route found');
  assert.doesNotMatch(
    route.line,
    /\.\.\.(workoutGated|metricsGated|vaultGated)\b/,
    'the fan-in route must stay ungated so booking-service can always call it',
  );

  const ctrl = readFileSync(
    join(here, '..', 'controllers', 'sessionController.js'),
    'utf8',
  );
  const fn = ctrl.match(
    /recordAttendanceForWorkout[\s\S]*?\n}/,
  )?.[0];
  assert.ok(fn, 'could not find recordAttendanceForWorkout in sessionController');
  assert.match(
    fn,
    /isAnyFeatureEnabled\('workoutTracking', 'healthMetrics'\)|isAnyFeatureEnabled\(/,
    'the handler must check the workout flag itself',
  );
});

test('route ordering that this file depends on is preserved', () => {
  // Three separate footguns, all of which produce a 404 or a 400 that looks
  // like a client bug. Each has been hit in this service already.
  const order = (a, b) => {
    const ai = all.findIndex((r) => r.line.includes(a));
    const bi = all.findIndex((r) => r.line.includes(b));
    assert.ok(ai > -1 && bi > -1, `expected both ${a} and ${b} to exist`);
    return ai < bi;
  };
  assert.ok(
    order("'/sessions/today'", "'/sessions/:id'"),
    '/sessions/today must precede /sessions/:id or "today" parses as an id',
  );
  assert.ok(
    order("'/runs/summary'", "'/runs/:id'"),
    '/runs/summary must precede /runs/:id or "summary" parses as an id',
  );
  assert.ok(
    order("'/biometrics/latest'", "'/biometrics/:metric/"),
    '/biometrics/latest must precede /biometrics/:metric or "latest" parses as a metric',
  );
  assert.ok(
    order("'/assistant/conversations'", "'/assistant/conversations/:id'"),
    'the collection route must precede the parameterized one',
  );
  // The ledger router is mounted with router.use, so its own ordering
  // (pause-before-date, in ledgerRoutingGates.test.js) is unaffected by this.
  assert.match(
    routes,
    /router\.use\(ledgerRouter\)/,
    'the ledger must stay a mounted router — it needs its own gate order',
  );
});
