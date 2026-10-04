import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// This service is where money-adjacent gamification state actually moves:
// coin ledger rows, streak state, challenge enrolment, paired-streak coin
// awards. Every one of those routes is flag-gated in the middleware chain, and
// that gate is the ONLY thing standing between "an admin turned the feature off
// for a cohort" and the route still doing writes.
//
// Two distinct failure modes are covered here, and the second is the one that
// has actually bitten this codebase before.
//
// 1. A route is on the wrong flag, or lost its gate during a refactor. The
//    health-service split (2026-10-04) is the precedent: `healthMetrics` still
//    existed and still gated a real feature, so a route left behind on it kept
//    returning 200 for anyone whose admin happened to have it on. Nothing
//    failed. Hence a MATRIX, not a spot check - each route asserts the flag it
//    must be on AND that it is not on either sibling.
//
// 2. A flag NAME here is not a flag in the registry. This service cannot use
//    auth-service's `assertKnownFlag` (which throws at boot): it is a separate
//    deployable that learns flags at runtime by fetching GET /app-config, so it
//    holds the name as a bare string. And `isFeatureEnabled` is
//    `!!flags?.[name]?.enabled` - an unknown name resolves FALSE, i.e. fail
//    CLOSED. So renaming or typo-ing a flag in the registry turns a live route
//    into a permanent silent 403 for every user, with no boot error, no log
//    line, and no failing test anywhere. The registry is the single source of
//    truth, but nothing forced this service to agree with it - hence the
//    cross-check below against the real exported list.
//
// Textual, like health-service's routeSplitGates.test.js: no database, no app
// instance, and it fails the moment the routing table changes shape. The
// registry is read by dynamic import (not by parsing) so the test cannot be
// satisfied by a comment or a string that merely looks like a flag name; the
// path is built from import.meta.url, so it does not depend on the CWD that
// CI's per-service `npm test` happens to use.

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, '..', 'routes', 'challenges.js'), 'utf8');
const controller = readFileSync(
  join(here, '..', 'controllers', 'challengeController.js'),
  'utf8',
);

const STREAKS = 'streaksCoins';
const CHALLENGES = 'challenges';
const PAIRED = 'buddyPairedStreaks';
const GAMIFICATION_FLAGS = [STREAKS, CHALLENGES, PAIRED];

// Whole statements, not lines: a route declaration can wrap, and a line-based
// scan would lose the path and so could not be matched against the matrix.
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
    const flat = stmt.replace(/\s+/g, ' ').trim();
    const head = flat.match(/^router\.(get|post|put|patch|delete)\('([^']+)'/);
    assert.ok(head, `line ${start + 1}: cannot parse route declaration: ${flat}`);
    out.push({
      method: head[1].toUpperCase(),
      path: head[2],
      line: flat,
      n: start + 1,
      gates: [...flat.matchAll(/requireFeatureFlag\('([^']+)'\)/g)].map((m) => m[1]),
      auth: /\brequireAuth\b/.test(flat),
      internal: /\brequireInternal\b/.test(flat),
      roles: [...flat.matchAll(/requireRole\('([^']+)'\)/g)].map((m) => m[1]),
    });
  }
  return out;
}

const all = routeStatements();
const byKey = new Map(all.map((r) => [`${r.method} ${r.path}`, r]));

// The matrix. `null` means deliberately NOT flag-gated, and every such entry
// carries its reason at the call site in routes/challenges.js.
const MATRIX = [
  // ---- customer-facing ------------------------------------------------
  // Streaks + the coin wallet/catalog/redeem trio are one surface on one flag.
  // `coins/redeem` in particular must not drift onto `challenges`: it spends a
  // balance, and a challenge-catalogue flag flip should not silently unlock a
  // spend path or vice versa.
  ['GET', '/streak/me', STREAKS],
  ['GET', '/coins/wallet', STREAKS],
  ['GET', '/coins/catalog', STREAKS],
  ['POST', '/coins/redeem', STREAKS],
  // Challenge list/detail/enrolment/leave/checkpoint + the Sprout spawn surface.
  ['GET', '/', CHALLENGES],
  ['GET', '/:id', CHALLENGES],
  ['POST', '/:id/enroll', CHALLENGES],
  ['POST', '/:id/leave', CHALLENGES],
  ['POST', '/:id/checkpoint', CHALLENGES],
  ['GET', '/:id/sprouts', CHALLENGES],
  ['POST', '/:id/sprouts/:spawnId/catch', CHALLENGES],
  // Paired streaks are a THIRD flag, not a streak sub-feature: opt-in writes a
  // row and auto-enrols the other member, so it is held separately (the
  // registry records the known unmatch bug while it is dark).
  ['POST', '/paired-streaks/opt-in', PAIRED],
  ['GET', '/paired-streaks/me', PAIRED],
  // ---- internal, flag-gated -------------------------------------------
  // Same flag as the customer routes above: these are the writes the customer
  // routes trigger, so gating one half only would leave the state mutable
  // while the UI reads it as switched off.
  ['POST', '/internal/streak/close-week', STREAKS],
  ['POST', '/internal/coins/:userId/credit', STREAKS],
  ['POST', '/internal/coins/:userId/debit', STREAKS],
  ['POST', '/internal/workout-credit', STREAKS],
  ['POST', '/internal/coins/redemptions', STREAKS],
  // ---- internal, deliberately ungated ----------------------------------
  // Each checks its own flag inside the handler (one attendance event is
  // relevant to streaksCoins, challenges and buddyPairedStreaks
  // independently, so the route cannot be gated wholesale).
  ['POST', '/internal/attendance-events', null],
  ['GET', '/internal/attendance-events', null],
  // A refund must always be payable, or turning a feature off would strand
  // customers' money.
  ['POST', '/internal/coins/redemptions/:redemptionId/refund', null],
  // DPDPA: erasure and access (s.11) must never be behind a feature flag.
  ['POST', '/internal/erase/:userId', null],
  ['GET', '/internal/export/:userId', null],
];

const adminRoutes = all.filter((r) => r.path.startsWith('/admin/'));

test('every non-admin route is classified in the matrix', () => {
  const mapped = new Set(MATRIX.map(([m, p]) => `${m} ${p}`));
  const adminKeys = new Set(adminRoutes.map((r) => `${r.method} ${r.path}`));
  const unmapped = all
    .map((r) => `${r.method} ${r.path}`)
    .filter((k) => !mapped.has(k) && !adminKeys.has(k));
  assert.deepEqual(
    unmapped,
    [],
    'new route(s) must be added to MATRIX with the flag they belong on - an unclassified route is an ungated route',
  );
});

test('every matrix entry matches a real route (no stale rows)', () => {
  for (const [method, path] of MATRIX) {
    assert.ok(
      byKey.has(`${method} ${path}`),
      `matrix lists ${method} ${path}, which is not in routes/challenges.js`,
    );
  }
});

test('each route sits on exactly its own flag and neither sibling', () => {
  for (const [method, path, expected] of MATRIX) {
    const r = byKey.get(`${method} ${path}`);
    const label = `${method} ${path} (line ${r.n})`;

    if (expected === null) {
      assert.deepEqual(
        r.gates,
        [],
        `${label} is listed as deliberately ungated but has requireFeatureFlag(${JSON.stringify(r.gates)})`,
      );
      continue;
    }

    assert.deepEqual(
      r.gates,
      [expected],
      `${label} must be gated by exactly '${expected}', found ${JSON.stringify(r.gates)}`,
    );
    for (const other of GAMIFICATION_FLAGS.filter((f) => f !== expected)) {
      assert.ok(
        !r.gates.includes(other),
        `${label} must not also be gated by '${other}'`,
      );
    }
    // Internal callers authenticate with an ID token + shared key rather than a
    // user session, so the auth assertion follows the route's own front door.
    if (path.startsWith('/internal/')) {
      assert.ok(
        r.internal,
        `${label} is internal and must keep requireInternal`,
      );
      assert.ok(!r.auth, `${label} is internal and must not use requireAuth`);
    } else {
      assert.ok(r.auth, `${label} is customer-facing and must keep requireAuth`);
      assert.ok(
        !r.internal,
        `${label} is customer-facing and must not be requireInternal`,
      );
    }
  }
});

test('admin routes are role-gated and never flag-gated', () => {
  // Deliberate, and load-bearing: an admin must be able to configure and
  // inspect a feature while it is off for customers - otherwise the first
  // pilot cannot be set up without a code deploy.
  assert.ok(adminRoutes.length >= 15, `only ${adminRoutes.length} admin routes found`);
  for (const r of adminRoutes) {
    const label = `${r.method} ${r.path} (line ${r.n})`;
    assert.deepEqual(r.gates, [], `${label} must not be flag-gated`);
    assert.deepEqual(r.roles, ['gobhi'], `${label} must be requireRole('gobhi')`);
    assert.ok(!r.internal, `${label} must not be requireInternal`);
  }
});

test('every flag name this service references exists in the registry', async () => {
  const registry = await import(
    pathToFileURL(
      join(here, '..', '..', 'auth-service', 'config', 'featureFlagRegistry.js'),
    ).href
  );
  const known = new Set(registry.flagNames());

  // Route-level gates plus the handler-level `isFeatureEnabled` checks, which
  // are the ones most likely to be added in a hurry and least likely to be
  // reviewed against the registry.
  const referenced = new Set([
    ...all.flatMap((r) => r.gates),
    ...[...controller.matchAll(/isFeatureEnabled\('([^']+)'\)/g)].map((m) => m[1]),
  ]);

  const unknown = [...referenced].filter((f) => !known.has(f)).sort();
  assert.deepEqual(
    unknown,
    [],
    `unknown flag name(s) ${JSON.stringify(unknown)} - isFeatureEnabled resolves these to false, ` +
      'so every route behind them is a permanent silent 403',
  );

  // And the other direction: this service should not quietly depend on a flag
  // nobody declared as its surface. Pinned so adding a 4th gamification flag
  // here forces GAMIFICATION_FLAGS and the matrix to be reconsidered rather
  // than slipping past as a sibling that no test knows about.
  assert.deepEqual(
    [...referenced].sort(),
    [...GAMIFICATION_FLAGS].sort(),
    'the set of gamification flags referenced here changed - update GAMIFICATION_FLAGS and the matrix deliberately',
  );
});

test('the attendance handler checks each gamification flag independently', () => {
  // The reason /internal/attendance-events is ungated at the route level: one
  // verified check-in is simultaneously a streak/coin signal, challenge
  // progress, and a paired-streak qualification, and they are three separate
  // flags. If one of these checks is dropped, that concern keeps writing rows
  // while the admin believes the feature is off.
  const inHandler = [...controller.matchAll(/isFeatureEnabled\('([^']+)'\)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...new Set(inHandler)].sort(),
    [...GAMIFICATION_FLAGS].sort(),
    `in-handler flag checks changed: ${JSON.stringify(inHandler)}`,
  );
});
