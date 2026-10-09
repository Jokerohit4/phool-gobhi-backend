import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The app's score controls (calm mode, pause, attainment, score target) checked
// against the routes that back them.
//
// This exists because S1 shipped: the app called seven paths this router has
// never declared (POST /ledger/score/calm, /score/pause/:date,
// /attainment/:date, /targets/current/:date, POST/DELETE /targets), so calm
// mode, pausing, the attainment row and the score target all 404'd silently on
// every device. The path-only guard in appointmentRouteContract.test.js did not
// catch it because several of those strings look like paths that could exist,
// and the verb mattered just as much: the server answers PUT where the app
// posted. So this test pairs each verb with its path, and reads the Dart source
// directly - a backend runner cannot execute Dart, and the failure being
// guarded is exactly a call that exists on one side and not the other.
//
// The app repo is a sibling checkout, not a dependency, so a missing one skips
// rather than fails: a backend CI runner should not be blocked by a path it does
// not own.

const here = dirname(fileURLToPath(import.meta.url));
const routesSource = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');

const appRepo = resolve(here, '..', '..', '..', '..', 'phool-gobhi-customer-app');
const dartSourcePath = join(
  appRepo,
  'lib',
  'data',
  'data_sources',
  'health_ledger_api_data_source.dart',
);
const hasAppCheckout = existsSync(dartSourcePath);
const skipApp = hasAppCheckout ? false : `no app checkout at ${appRepo}`;

// The score surface this test covers: everything the calm/pause/attainment/
// target widgets call. The series and safety reads are included so the whole
// card is under one guard rather than only its buttons.
const SCORE_TAILS = [
  '/ledger/score',
  '/ledger/score/calm',
  '/ledger/score/calm-mode',
  '/ledger/score/safety',
  '/ledger/score/pause',
  '/ledger/score/blended',
  '/ledger/attainment',
  '/ledger/score/target',
];

/** Every verb+path pair the Dart data source issues for the score surface. */
function scoreCallsByApp() {
  const dart = readFileSync(dartSourcePath, 'utf8');
  // Dart interpolates ('/ledger/score/$localDate/preview'); Express spells the
  // same idea ':localDate'. Rewritten rather than truncated for the reason the
  // appointment test gives: truncation invents mismatches that do not exist.
  const calls = [];
  const re = /_client\.(get|post|put|patch|delete)\(\s*'(\/api\/health\/[^']*)'/g;
  for (const m of dart.matchAll(re)) {
    const path = m[2].replace(/\$\{?\w+\}?/g, ':param');
    if (SCORE_TAILS.some((tail) => path === `/api/health${tail}` || path.startsWith(`/api/health${tail}/`))) {
      calls.push({ verb: m[1], path });
    }
  }
  return calls;
}

test('every score call the app issues matches a declared route verb+path', { skip: skipApp }, () => {
  const calls = scoreCallsByApp();

  assert.ok(
    calls.length >= SCORE_TAILS.length,
    `only ${calls.length} score calls found in the Dart data source. If the app ` +
      'renamed its prefix or its client helper this test is now asserting ' +
      'nothing, not passing - the failure below would never be reported.',
  );

  // The gateway mounts this service at /api/health and the service mounts its
  // router at '/', so '/ledger/...' here is '/api/health/...' out there. Read
  // from the gateway so the other half of the prefix cannot drift unnoticed.
  const gatewaySource = readFileSync(resolve(here, '..', '..', '..', 'index.js'), 'utf8');
  const mountedAt = gatewaySource.match(/app\.use\('(\/api\/health[^']*)'/);
  assert.ok(
    mountedAt,
    'the gateway no longer mounts this service at a path starting /api/health, so ' +
      'every route in this file has moved and nothing else would say so',
  );
  const mount = mountedAt[1].replace(/\/$/, '');

  for (const { verb, path } of calls) {
    const tail = path.slice(mount.length);
    const pattern = tail
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\$[a-zA-Z_]\w*/g, ':param')
      // The app's interpolated name need not equal the router's (:param vs
      // :localDate) - only the position matters, so match any :name segment.
      .replace(/:param/g, ':[A-Za-z_]\\w*');
    const declared = new RegExp(`router\\.${verb}\\(\\s*['"]${pattern}['"]`);
    assert.ok(
      declared.test(routesSource),
      `the app issues ${verb.toUpperCase()} ${path} but the health router declares ` +
        'no such route. The server answers 404 and the app shows an empty or ' +
        'stuck control - calm mode, pause, attainment or the score target ' +
        'silently doing nothing.',
    );
  }
});

test('the score surface the app calls is all present on the router', () => {
  // The reverse direction: a route that exists but the app stopped calling, or
  // one that was renamed on the server only. Checked as a fixed list rather
  // than derived from the Dart so a Dart-side regression (an entire method
  // deleted) still fails here instead of passing by having nothing to assert.
  for (const tail of SCORE_TAILS) {
    const anyVerb = new RegExp(
      `router\\.(get|post|put|patch|delete)\\(\\s*['"]${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    assert.ok(
      anyVerb.test(routesSource),
      `the health router no longer declares any route at ${tail}, which the app's ` +
        'score card calls. A rename here is a dead control in every build of ' +
        'the app already in the wild.',
    );
  }
});

test('every write on the score surface is a PUT or DELETE, never a POST', () => {
  // The bug that shipped: the app POSTed to calm-mode, pause and targets while
  // the router answered PUT. Express 404s a method mismatch the same as a path
  // mismatch, and nothing else in either repo notices. Pinning the verbs here
  // means the next person to change one side sees this test rather than a user
  // seeing a toggle that snaps back.
  const writes = [
    { tail: '/ledger/score/calm-mode', verbs: ['put'] },
    { tail: '/ledger/score/pause', verbs: ['put', 'delete'] },
    { tail: '/ledger/score/target', verbs: ['put', 'delete'] },
  ];

  for (const { tail, verbs } of writes) {
    for (const verb of verbs) {
      const declared = new RegExp(
        `router\\.${verb}\\(\\s*['"]${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
      );
      assert.ok(
        declared.test(routesSource),
        `router.${verb}('${tail}') is missing; the app writes the score surface ` +
          `with ${verbs.map((v) => v.toUpperCase()).join('/')} and nothing else.`,
      );
    }
  }
});

test('every score route is gated on the same consent scope', () => {
  // Same failure class as the appointment gate: these routes serve score and
  // weight-derived data, and the nutrition scope is the consent that covers
  // them. A route that lost the gate serves health data to anyone who can
  // reach it, which no screen-level error would ever report.
  const gate = /\.\.\.nutrition\s*,\s*(ledgerCtrl|scoreService|attainmentService)\.\w+/;
  const scoreRoutes = [
    ...routesSource.matchAll(
      /router\.(get|post|put|patch|delete)\(\s*'\/ledger\/(score[^']*|attainment[^']*)'/g,
    ),
  ];

  assert.ok(
    scoreRoutes.length >= SCORE_TAILS.length,
    `only ${scoreRoutes.length} score routes found in ledger.js - if the prefix ` +
      'changed this test now asserts nothing',
  );

  for (const match of scoreRoutes) {
    const verb = match[1];
    const path = match[0];
    const from = routesSource.indexOf(path);
    assert.match(
      routesSource.slice(from, from + 200),
      gate,
      `${verb.toUpperCase()} ${path.replace(/^router\.\w+\(/, '').replace(/'$/, '')} is ` +
        'missing its ...nutrition consent gate. The other score routes have it; ' +
        'an endpoint without it serves score and weight data unconsented.',
    );
  }
});

test('the reads that require `today` take it from the query, as the app sends it', () => {
  // getPause, getAttainment and getScoreTarget all validate `req.query.today`
  // and 400 without it - so a server that took it from the path, or a body,
  // would fail every read the app makes. The app sends it in queryParameters;
  // this pins the controller side of that agreement by reading the handlers.
  const controllerSource = readFileSync(
    join(here, '..', 'controllers', 'ledgerController.js'),
    'utf8',
  );

  const handlers = [
    { name: 'getPause', why: 'the pause state read' },
    { name: 'getAttainment', why: 'the goal-attainment row' },
    { name: 'getScoreTarget', why: 'the score-target read' },
  ];

  for (const { name, why } of handlers) {
    const body = controllerSource.match(
      new RegExp(`export const ${name} = handle\\(async \\(req\\) =>([\\s\\S]*?)\\);`),
    );
    assert.ok(body, `export const ${name} is missing from ledgerController.js`);
    assert.match(
      body[1],
      /requireToday\(req\.query\?\.today\)/,
      `${name} (${why}) no longer reads req.query.today through requireToday, but ` +
        'the app sends today as a query parameter. A mismatch here 400s or ' +
        'mis-dates every read the score card makes.',
    );
  }
});
