import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The app's appointment screen, checked against the routes that are supposed to
// back it.
//
// Textual, and reads the Dart source directly, for the same reason the report
// contract test does: the failure being guarded is a path that exists on one side
// and not the other. Every unit test in this service can pass while the app calls
// '/ledger/appointments/next' and Express answers 404, because the app is a
// different repo with a different test runner and no shared type to complain.
// Nothing fails. The appointments screen shows an empty list, which reads as
// "this user has no appointments" rather than "we are calling a route that does
// not exist".
//
// The app repo is a sibling checkout, not a dependency, so a missing one skips
// rather than fails: a backend CI runner should not be blocked by a path it does
// not own. The cost is that this check can quietly stop running.

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
const screenSourcePath = join(
  appRepo,
  'lib',
  'presentation',
  'pages',
  'health',
  'doctor_appointments_screen.dart',
);
const hasAppCheckout = existsSync(dartSourcePath);
const skipApp = hasAppCheckout ? false : `no app checkout at ${appRepo}`;

/** Every '/api/health/...' literal in the Dart data source. */
function pathsCalledByApp() {
  const dart = readFileSync(dartSourcePath, 'utf8');
  // Dart interpolates the id ('/ledger/appointments/$id'); Express spells the same
  // idea ':id'. Rewritten rather than truncated, because truncating turns the
  // delete into '/ledger/appointments/', which matches no route and would report a
  // mismatch that does not exist.
  return new Set(
    [...dart.matchAll(/'(\/api\/health\/ledger\/appointments[^']*)'/g)].map((m) =>
      m[1].replace(/\$\{?\w+\}?/g, ':id'),
    ),
  );
}

test('every appointment path the app calls exists as a route', { skip: skipApp }, () => {
  const called = pathsCalledByApp();

  assert.ok(
    called.size > 0,
    'no /api/health/ledger/appointments paths found in the Dart data source. If ' +
      'the app renamed its prefix this test is now asserting nothing, not ' +
      'passing - the failure below would never be reported.',
  );

  // The full path spans two files in two places. The gateway mounts this service
  // at /api/health and the service mounts its router at '/', so '/ledger/...'
  // here is '/api/health/ledger/...' out there. Reading the prefix from either
  // file alone lets the other half drift with nothing to notice.
  const gatewaySource = readFileSync(
    resolve(here, '..', '..', '..', 'index.js'),
    'utf8',
  );
  const mountedAt = gatewaySource.match(/app\.use\('(\/api\/health[^']*)'/);
  assert.ok(
    mountedAt,
    'the gateway no longer mounts this service at a path starting /api/health, so ' +
      'every route in this file has moved and nothing else would say so',
  );
  const mount = mountedAt[1].replace(/\/$/, '');

  for (const path of called) {
    const tail = path.slice(mount.length);
    const pattern = tail
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\$[a-zA-Z_]\w*/g, ':id');
    const verb = new RegExp(
      `router\\.(get|post|put|patch|delete)\\(\\s*['"]${pattern}['"]`,
    );
    assert.ok(
      verb.test(routesSource),
      `the app calls ${path} but no route on the health router matches it. A renamed ` +
        'or unmounted route here surfaces only in the app, as a permanently empty ' +
        'list or a 404 nobody notices until a user reports it.',
    );
  }
});

test('the app calls every appointment verb it needs, and the router declares it', () => {
  // The reverse direction of the test above. Checking only "what the app calls
  // exists" would pass on a screen that quietly lost its delete call, and a user
  // with an appointment they cannot remove is a worse bug than a missing route:
  // nothing errors, the row just stays.
  const required = [
    { verb: 'get', path: '/ledger/appointments', why: 'the list' },
    { verb: 'post', path: '/ledger/appointments', why: 'adding one' },
    { verb: 'get', path: '/ledger/appointments/next', why: 'the next-appointment row' },
    { verb: 'get', path: '/ledger/appointments/:id', why: 'opening one' },
    { verb: 'patch', path: '/ledger/appointments/:id', why: 'editing one' },
    { verb: 'delete', path: '/ledger/appointments/:id', why: 'removing one' },
  ];

  for (const { verb, path, why } of required) {
    const declared = new RegExp(
      `router\\.${verb}\\(\\s*['"]${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    assert.ok(
      declared.test(routesSource),
      `the appointment ${why} needs ${verb.toUpperCase()} ${path}, which the ` +
        'health router does not declare',
    );
  }
});

test('next is registered before :id so it is not read as an id', () => {
  // Express matches in registration order, and 'next' is a string where :id
  // expects a number. Declared in the wrong order, GET /appointments/next runs
  // the :id handler with id='next', which parses to NaN and 404s - permanently,
  // against a lookup that has nothing wrong with it.
  const nextAt = routesSource.indexOf("router.get('/ledger/appointments/next'");
  const idAt = routesSource.indexOf("router.get('/ledger/appointments/:id'");

  assert.ok(nextAt > -1, 'the next-appointment route is missing entirely');
  assert.ok(idAt > -1, 'the by-id route is missing entirely');
  assert.ok(
    nextAt < idAt,
    "router.get('/ledger/appointments/next') is declared after /:id, so Express " +
      'will match next as an id and the lookup 404s for every user',
  );
});

test('every appointment route is gated on the same consent scope', () => {
  // All six routes carry ...nutrition. A split here would mean an endpoint that
  // returns a user's medical schedule without checking the consent that covers
  // medical data - the one failure in this file that is a breach rather than a
  // broken screen, and the one that cannot be noticed by a user reporting an
  // empty screen.
  const gate = /\.\.\.nutrition\s*,\s*appointmentCtrl\.\w+/;
  const appointmentRoutes = [
    ...routesSource.matchAll(
      /router\.(get|post|patch|delete)\(\s*'\/ledger\/appointments[^']*'/g,
    ),
  ];

  assert.ok(
    appointmentRoutes.length > 0,
    'no appointment routes were found in ledger.js - if the prefix changed this ' +
      'test now asserts nothing',
  );

  for (const match of appointmentRoutes) {
    const verb = match[1];
    const path = match[0];
    const from = routesSource.indexOf(path);
    assert.match(
      routesSource.slice(from, from + 200),
      gate,
      `${verb.toUpperCase()} ${path.replace(/^router\.\w+\(/, '').replace(/'$/, '')} is ` +
        'missing its ...nutrition consent gate. The other appointment routes have ' +
        'it; an endpoint without it serves medical data to anyone who can reach it.',
    );
  }
});

test('the appointment screen does not claim to contact the clinic', { skip: skipApp }, () => {
  if (!existsSync(screenSourcePath)) return;

  const screen = readFileSync(screenSourcePath, 'utf8');

  // The screen is a record of a booking. It has no way to send a reminder and no
  // integration that could, so a promise of one would be a lie the user finds out
  // about by missing a visit - the worst possible time to learn it.
  for (const promise of ['remind', 'reminder', 'we will text', 'we will call', 'book it for you']) {
    assert.ok(
      !screen.toLowerCase().includes(promise),
      `the appointment screen says "${promise}". This screen stores a booking and ` +
        'nothing else; promising a reminder implies a delivery path that does not ' +
        'exist.',
    );
  }
});

test('the appointment screen is reachable and gates itself on the vault', { skip: skipApp }, () => {
  const routesPath = join(appRepo, 'lib', 'presentation', 'routes', 'app_routes.dart');
  if (!existsSync(routesPath)) return;

  const routes = readFileSync(routesPath, 'utf8');

  assert.match(
    routes,
    /static const String healthAppointments\s*=/,
    'the appointments screen has no named route, so the medical-documents entry ' +
      'point can only reach it by hardcoding a path',
  );

  // The screen holds medical data, so it belongs to the same gated route set as
  // the rest of the ledger. Outside that set it would render behind no consent
  // check at all.
  assert.match(
    routes,
    /_ledgerRoutes[\s\S]{0,4000}healthAppointments/,
    'healthAppointments is not in the ledger route set, so it is not covered by ' +
      'the consent and feature-flag gates that set carries',
  );
});