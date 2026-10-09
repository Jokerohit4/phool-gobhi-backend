import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The logged-food surface the app reads and writes, checked against the routes
// and the payload that back it.
//
// S1 shipped seven score calls this router had never declared, and every one of
// them failed silently on device. The same class of failure is available on
// food: the entry list the card renders, the correction PATCH and the photo
// link each have to exist on both sides, with the same verb, or a screen shows
// an empty list, a snackbar or a spinner that never resolves.
//
// The correction is new, and new endpoints are where the two sides drift most
// easily - so the verb is pinned as well as the path. Express 404s a method
// mismatch exactly as it 404s a path mismatch, and neither repo would notice.
//
// The app repo is a sibling checkout, not a dependency, so a missing one skips
// rather than fails: a backend CI runner should not be blocked by a path it does
// not own.

const here = dirname(fileURLToPath(import.meta.url));
const routesSource = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');
const serviceSource = readFileSync(
  join(here, '..', 'services', 'ledger', 'nutritionService.js'),
  'utf8',
);

const appRepo = resolve(here, '..', '..', '..', '..', 'phool-gobhi-customer-app');
const dartDataPath = join(
  appRepo,
  'lib',
  'data',
  'data_sources',
  'health_ledger_api_data_source.dart',
);
const dartModelPath = join(appRepo, 'lib', 'data', 'models', 'food_entry_model.dart');
const hasAppCheckout = existsSync(dartDataPath) && existsSync(dartModelPath);
const skipApp = hasAppCheckout ? false : `no app checkout at ${appRepo}`;

// Prefixes this test treats as the logged-food surface. Both are under /ledger,
// so the app spells them /api/health/ledger/... and this router /ledger/....
const FOOD_LOG_PREFIXES = ['/ledger/food-logs', '/ledger/food-totals'];

/** Every verb+path pair the Dart data source issues for logged food. */
function foodCallsByApp() {
  const dart = readFileSync(dartDataPath, 'utf8');
  // Dart interpolates ('/ledger/food-logs/$id'); Express spells the same idea
  // ':id'. Rewritten rather than truncated, for the reason scoreRouteContract
  // gives: truncation invents mismatches that do not exist.
  const calls = [];
  const re = /_client\.(get|post|put|patch|delete)\(\s*'(\/api\/health\/[^']*)'/g;
  for (const m of dart.matchAll(re)) {
    const path = m[2].replace(/\$\{?\w+\}?/g, ':param');
    if (FOOD_LOG_PREFIXES.some((p) => path === `/api/health${p}` || path.startsWith(`/api/health${p}/`))) {
      calls.push({ verb: m[1], path });
    }
  }
  return calls;
}

test('every logged-food call the app issues matches a declared route verb+path', { skip: skipApp }, () => {
  const calls = foodCallsByApp();

  // Four distinct calls at minimum: log, list, correct, remove. A number below
  // that means the extractor stopped matching and this test is now asserting
  // nothing rather than passing.
  assert.ok(
    calls.length >= 4,
    `only ${calls.length} logged-food calls found in the Dart data source. If the ` +
      'app renamed its prefix or its client helper this test now asserts ' +
      'nothing, not passing.',
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
      // :id) - only the position matters, so match any :name segment.
      .replace(/:param/g, ':[A-Za-z_]\\w*');
    const declared = new RegExp(`router\\.${verb}\\(\\s*['"]${pattern}['"]`);
    assert.ok(
      declared.test(routesSource),
      `the app issues ${verb.toUpperCase()} ${path} but the health router declares ` +
        'no such route. The server answers 404, so a logged meal never appears, ' +
        'a correction never sticks and the card the user is looking at is ' +
        'not the day that was sent.',
    );
  }
});

test('the logged-food routes the app depends on are all declared', () => {
  // The reverse direction: a route that exists but the app stopped calling, or
  // one renamed on the server only. A fixed list rather than something derived
  // from the Dart, so an entire method deleted from the app still fails here.
  const required = [
    { verb: 'post', path: '/ledger/food-logs', why: 'logging a meal' },
    { verb: 'delete', path: '/ledger/food-logs/:id', why: 'removing an entry' },
    { verb: 'patch', path: '/ledger/food-logs/:id', why: 'correcting an entry' },
    { verb: 'get', path: '/ledger/food-totals/:localDate', why: "today's list" },
    { verb: 'get', path: '/ledger/food-logs/:id/photo', why: 'opening a photo' },
  ];

  for (const { verb, path, why } of required) {
    const declared = new RegExp(
      `router\\.${verb}\\(\\s*['"]${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    assert.ok(
      declared.test(routesSource),
      `router.${verb}('${path}') is missing - that route backs ${why}, which the ` +
        'app already ships. A rename here is a 404 in every build in the wild.',
    );
  }
});

test('correcting an entry is a PATCH on both sides, not a POST or a PUT', { skip: skipApp }, () => {
  // The verb is pinned separately because it is the newest call on this surface
  // and the one a future edit is most likely to change to something that looks
  // right. The app says:
  //
  //   final res = await _client.patch('/api/health/ledger/food-logs/$id', ...)
  //
  // and this router answers router.patch('/ledger/food-logs/:id', ...). If one
  // side moves, Express 404s it identically to a missing path and the only
  // symptom is a snackbar after the user has typed a new size.
  const dart = readFileSync(dartDataPath, 'utf8');
  const appCorrects = /_client\.patch\(\s*'\/api\/health\/ledger\/food-logs\//.test(dart);
  const routerCorrects = /router\.patch\(\s*['"]\/ledger\/food-logs\/:id['"]/.test(routesSource);

  assert.ok(appCorrects, 'the app no longer PATCHes a food log');
  assert.ok(
    routerCorrects,
    "the health router no longer PATCHes '/ledger/food-logs/:id'. The app corrects " +
      'entries with PATCH; a server that answers another verb 404s every ' +
      'correction.',
  );
  assert.ok(
    !/router\.post\(\s*['"]\/ledger\/food-logs\/:id['"]/.test(routesSource),
    "a router.post('/ledger/food-logs/:id') would shadow nothing but reads wrong: " +
      'posting to a single row is how logging was done before the correction ' +
      'existed, and it would make the two indistinguishable here.',
  );
});

test('every logged-food route is gated on the same consent scope', () => {
  // Same failure class as the score gate: these routes serve nutrition data, and
  // the nutrition scope is the consent that covers them. A route that lost the
  // gate serves what the user ate to anyone who can reach it, which no
  // screen-level error would ever report.
  const gate = /\.\.\.nutrition\s*,/;
  const foodRoutes = [
    ...routesSource.matchAll(
      /router\.(get|post|put|patch|delete)\(\s*'\/ledger\/food-(logs|totals)[^']*'/g,
    ),
  ];

  assert.ok(
    foodRoutes.length >= 5,
    `only ${foodRoutes.length} logged-food routes found in ledger.js - if the prefix ` +
      'changed this test now asserts nothing',
  );

  for (const match of foodRoutes) {
    const verb = match[1];
    const from = routesSource.indexOf(match[0]);
    assert.match(
      routesSource.slice(from, from + 160),
      gate,
      `${verb.toUpperCase()} ${match[0].replace(/^router\.\w+\(/, '').replace(/'$/, '')} is ` +
        'missing its ...nutrition consent gate. The other logged-food routes ' +
        'have it; an endpoint without it serves the day, unconsented.',
    );
  }
});

test("the day's rows ride on the totals response, on both sides", { skip: skipApp }, () => {
  // The card lists what was eaten from GET /ledger/food-totals/:localDate -
  // deliberately, so correcting a row costs no extra round trip on a screen that
  // already makes four reads before it can log anything. That decision is only
  // safe while both halves hold: the service returns the rows in that payload,
  // and the model reads them back out of it. Losing either side empties the list
  // while every test on the losing side still passes, because each side would
  // then be testing only its own half.
  const serviceBlock = serviceSource.slice(
    serviceSource.indexOf('export async function getDayTotals'),
    serviceSource.indexOf('export function deltaFromTarget'),
  );
  assert.ok(
    serviceBlock.length > 0,
    'getDayTotals was not found in nutritionService.js - the anchor this test reads ' +
      'moved, so nothing was asserted',
  );
  assert.match(
    serviceBlock,
    /return\s*\{[^}]*\blogs\b/,
    'getDayTotals no longer returns the rows alongside the counts. The food card ' +
      'lists them from this payload, so dropping `logs` empties the list while ' +
      'the counts still look correct.',
  );

  const modelSource = readFileSync(dartModelPath, 'utf8');
  const modelBlock = modelSource.slice(
    modelSource.indexOf('factory DayTotalsModel.fromJson'),
    modelSource.indexOf('final List<FoodLogModel> logs;'),
  );
  assert.ok(
    modelBlock.length > 0,
    'DayTotalsModel.fromJson was not found in food_entry_model.dart - the anchor this ' +
      'test reads moved, so nothing was asserted',
  );
  assert.match(
    modelBlock,
    /json\['logs'\]/,
    'DayTotalsModel.fromJson no longer reads the `logs` key, so every day would parse ' +
      'with an empty list and the card would show "nothing logged" under totals ' +
      'that are not empty.',
  );
});
