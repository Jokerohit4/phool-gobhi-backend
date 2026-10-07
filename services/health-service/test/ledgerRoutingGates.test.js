import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Gating is the whole security model of the ledger, and it is expressed as
// array spreads in a router file rather than as callables that can be invoked
// directly. That makes it easy to fat-finger: drop one middleware, or order two
// the wrong way round, and nothing fails until someone notices in production
// that a user without consent can read their own food log - which they are
// entitled to do anyway, so it may not even look wrong.
//
// So this checks the gates textually. It is not as strong as executing the
// middleware chain, but it runs with no database and no app instance, and it
// fails the moment a route loses its gate or gains the wrong one.

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');

// Parse whole statements, not lines. The upload route is a multi-line
// router.post(...) with the path and the middleware on separate lines, so a
// line-based scan sees only `router.post(` - it loses the path, so the route
// cannot be matched against the tests below, and it looks like a route with no
// gate on it. All three of those were failures from the parser, not the router.
function routeLines() {
  const out = [];
  const lines = routes.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('router.')) continue;
    const start = i;
    let stmt = lines[i];
    // Accumulate until parentheses balance.
    let depth = (stmt.match(/\(/g) || []).length - (stmt.match(/\)/g) || []).length;
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      stmt += `\n${lines[i]}`;
      depth += (lines[i].match(/\(/g) || []).length - (lines[i].match(/\)/g) || []).length;
    }
    out.push({ line: stmt.replace(/\s+/g, ' ').trim(), n: start + 1 });
  }
  return out;
}

const all = routeLines();
assert.ok(all.length > 20, `expected the ledger routes, found ${all.length}`);

test('every ledger route is authenticated', () => {
  // Each of these spreads `...nutrition`, `...medical`, `...consentGated` or
  // `...photo`, all of which begin with requireAuth. Internal routes
  // (service-to-service, e.g. wallet-service's rewards automation) instead
  // authenticate with `requireInternal` — that is auth too, not a gap.
  const ungated = all.filter(
    (r) =>
        !/\.\.\.(nutrition|medical|consentGated|photo)\b/.test(r.line) &&
        !/\brequireInternal\b/.test(r.line),
  );
  assert.deepEqual(
    ungated.map((r) => `${r.n}: ${r.line}`),
    [],
    'a ledger route neither spreads a gate array nor requires internal auth',
  );
});

test('every ledger route is behind the healthLedger flag', () => {
  // All three gate arrays include requireFeatureFlag('healthLedger'), so this
  // is really asserting that no route bypasses the shared arrays.
  const declared = /const ledgerGated = \[[^\]]*requireFeatureFlag\('healthLedger'\)/s;
  assert.match(routes, declared, 'ledgerGated must include the healthLedger feature flag');
  for (const which of ['nutrition', 'medical', 'consentGated']) {
    assert.match(
      routes,
      new RegExp(`const ${which} = \\[\\.\\.\\.ledgerGated`),
      `${which} must build on ledgerGated`,
    );
  }
  // `photo` deliberately builds on `nutrition` rather than on `ledgerGated`, so
  // it inherits both the healthLedger flag AND the nutrition scope. Asserted
  // separately because the rule it has to satisfy is different, and folding it
  // into the loop above would assert the wrong thing about it.
  assert.match(
    routes,
    /const photo = \[\.\.\.nutrition,\s*requireFeatureFlag\('foodPhotoLogging'\)\]/,
    'the photo gate must build on the nutrition gate and add the photo flag',
  );
});

// The photo routes are the only ones in this file that send a user's image to a
// third party, so their gating is asserted separately and in full rather than
// inferred from a shared array.
test('the photo routes are on the photo gate, and the photo gate is a fourth flag', () => {
  const photoRoutes = all.filter((r) => r.line.includes('/ledger/food-photos'));
  assert.equal(photoRoutes.length, 3, 'expected recognise, upload and confirm');

  for (const r of photoRoutes) {
    assert.match(r.line, /\.\.\.photo\b/, `${r.n}: ${r.line} is not on the photo gate`);
    assert.doesNotMatch(
      r.line,
      /\.\.\.consentGated\b/,
      `${r.n}: a feature route must not be reachable without nutrition consent`,
    );
  }

  // A flag the admin can turn on, and that a route can therefore also be wired
  // without. Asserted by name so that renaming the array - or dropping the flag
  // from it - is a failure rather than a silent widening of the gate.
  const decl = routes.match(/const photo = \[([^\]]*)\]/)?.[1] || '';
  assert.match(decl, /requireFeatureFlag\('foodPhotoLogging'\)/);
  assert.match(decl, /\.\.\.nutrition\b/);
});

test('the photo upload runs after the photo flag, not before it', () => {
  // Same ordering argument as the medical upload, and it matters more here: the
  // bytes in question are a photograph of somebody's plate, and the check that
  // decides whether we may read it has to happen before the server holds it.
  const upload = photoRoute('/ledger/food-photos/recognize');
  const flagAt = upload.line.indexOf('...photo');
  const multerAt = upload.line.indexOf('uploadFoodPhotoMiddleware');
  assert.ok(flagAt > -1 && multerAt > -1, 'could not find both middlewares on the photo upload route');
  assert.ok(flagAt < multerAt, 'the photo flag must come before the upload middleware');
});

test('the no-vision food-photo upload sits on the photo gate like recognize', () => {
  // The on-device matcher's storage half stores a photograph of a plate that
  // never reaches the vision model - which must not make it GATE-LIGHTER than
  // recognize. It is the same collection of bytes, the same consent question,
  // and the same reason the flag has to be checked before the server holds the
  // object. Asserted like recognize: on ...photo, nothing lighter, and the flag
  // before the multer buffer.
  const upload = photoRoute('/ledger/food-photos/upload');
  assert.ok(upload, 'no no-vision upload route found');
  assert.match(upload.line, /\.\.\.photo\b/, 'upload is not on the photo gate');
  assert.doesNotMatch(
    upload.line,
    /\.\.\.consentGated\b/,
    'a feature route must not be reachable without nutrition consent',
  );
  const flagAt = upload.line.indexOf('...photo');
  const multerAt = upload.line.indexOf('uploadFoodPhotoMiddleware');
  assert.ok(flagAt > -1 && multerAt > -1, 'could not find both middlewares on the no-vision upload route');
  assert.ok(flagAt < multerAt, 'the photo flag must come before the upload middleware');
});

test('a photo already confirmed stays readable after the flag is switched off', () => {
  // Deliberately on `nutrition` and NOT on the photo gate. A user who confirmed
  // a photo while the feature was on has to still be able to see it, and this
  // route only mints a link for a photo this service already holds - it moves no
  // image anywhere new, so it introduces no capability to gate.
  const link = all.find((r) => r.line.includes('/ledger/food-logs/:id/photo'));
  assert.ok(link, 'no photo link route found');
  assert.match(link.line, /^router\.get\(/);
  assert.match(link.line, /\.\.\.nutrition\b/);
  assert.doesNotMatch(
    link.line,
    /\.\.\.photo\b/,
    'a confirmed photo must not become unreadable when the flag is turned off',
  );
});

// The gate arrays are declared once and then spread by every route, which is
// the right structure - but it means the scope a route actually enforces is
// defined in ONE place, and a route's own text says nothing about which scope
// it gets. So the declarations themselves have to be checked.
//
// This was caught by mutating the source: swapping requireNutritionConsent and
// requireMedicalRecordsConsent between the two arrays left every route still
// on a valid gate, every test green, and food logs readable under medical-records
// consent only. The tests above could not see it because they only ever read
// the array name.
test('the nutrition array holds the nutrition scope, the medical array the medical one', () => {
  const decl = (name) =>
    routes.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1] || '';

  assert.match(
    decl('nutrition'),
    /requireNutritionConsent/,
    'the nutrition gate must check the nutrition scope',
  );
  assert.doesNotMatch(
    decl('nutrition'),
    /requireMedicalRecordsConsent/,
    'the nutrition gate must not check the medical scope',
  );
  assert.match(
    decl('medical'),
    /requireMedicalRecordsConsent/,
    'the medical gate must check the medical-records scope',
  );
  assert.doesNotMatch(
    decl('medical'),
    /requireNutritionConsent\b/,
    'the medical gate must not check the nutrition scope',
  );
});

function declNutrition() {
  return routes.match(/const nutrition = \[([^\]]*)\]/)?.[1] || '';
}
function declMedical() {
  return routes.match(/const medical = \[([^\]]*)\]/)?.[1] || '';
}

test('the two scopes are not the same middleware', () => {
  // Belt and braces on the same failure: if both arrays somehow ended up
  // pointing at one check, then granting nutrition consent would unlock the
  // prescription drawer.
  assert.notEqual(
    declNutrition().trim(),
    declMedical().trim(),
    'the nutrition and medical gates are identical',
  );
});

test('medical document routes are gated on the medical scope', () => {
  const docRoutes = all.filter((r) => r.line.includes('/ledger/medical-documents'));
  assert.ok(docRoutes.length >= 4, 'expected list, upload, link and delete routes');
  for (const r of docRoutes) {
    assert.match(r.line, /\.\.\.medical\b/, `${r.n}: ${r.line} is not on the medical gate`);
  }
});

test('food, plan and score routes are gated on the nutrition scope', () => {
  // These are all derived from what someone eats. Medical records are a
  // separate consent and must not be required to log a katori of rice - and
  // equally, a nutrition consent must not open the prescription drawer: the
  // drawer where a person's OWN uploaded prescription lives is
  // `/ledger/medical-documents`, on `...medical`, and is asserted below.
  //
  // `/ledger/prescription` is a third thing and is deliberately in this list
  // despite the name: it is the four-slider plan (calories, steps, sleep,
  // sessions) derived from what the person eats and how they train - the
  // same question `/ledger/targets` answers - not a medical document. The
  // name comes from the app's route contract, not from the medical scope.
  for (const prefix of ['/ledger/foods', '/ledger/food-logs', '/ledger/saved-meals', '/ledger/plan', '/ledger/score', '/ledger/targets', '/ledger/food-totals', '/ledger/prescription']) {
    const matching = all.filter((r) => r.line.includes(prefix));
    assert.ok(matching.length, `no routes found for ${prefix}`);
    for (const r of matching) {
      assert.match(r.line, /\.\.\.nutrition\b/, `${r.n}: ${r.line} is not on the nutrition gate`);
      assert.doesNotMatch(r.line, /\.\.\.medical\b/, `${r.n}: ${r.line} must not be on the medical gate`);
    }
  }
});

test('the consent endpoints themselves are NOT scope-gated', () => {
  // Otherwise there is no way to opt in: the only route that could grant a
  // scope would itself require that scope.
  const consent = all.filter((r) => r.line.includes('/ledger/consent'));
  assert.ok(consent.length >= 5, 'expected get, grant and revoke for both scopes');
  for (const r of consent) {
    assert.match(r.line, /\.\.\.consentGated\b/, `${r.n}: ${r.line} must use consentGated`);
    assert.doesNotMatch(r.line, /requireNutritionConsent|requireMedicalRecordsConsent/, `${r.n}: ${r.line} is self-blocking`);
  }
});

test('the upload middleware runs after the consent gate, not before', () => {
  // Ordering is load-bearing. multer buffers the file in memory, so a consent
  // check that ran after it would mean a user who has not consented to medical
  // records could still make the server read their file off the socket.
  const upload = all.find((r) => r.line.startsWith('router.post') && r.line.includes('/ledger/medical-documents'));
  assert.ok(upload, 'no upload route found');
  // Positions are compared within the one route statement, so a stray
  // '...medical' elsewhere in the file cannot satisfy the check.
  const consentAt = upload.line.indexOf('...medical');
  const multerAt = upload.line.indexOf('uploadMedicalDocumentMiddleware');
  assert.ok(consentAt > -1 && multerAt > -1, 'could not find both middlewares on the upload route');
  assert.ok(
    consentAt < multerAt,
    'the consent gate must come before the upload middleware, or the file is read before consent is checked',
  );
});

function photoRoute(pathFragment) {
  const found = all.find((r) => r.line.includes(pathFragment));
  assert.ok(found, `no route found for ${pathFragment}`);
  return found;
}

test('the consent gate does not appear after a handler', () => {
  // Guards against `router.post(path, handler, ...gated)`, which Express would
  // run with no auth at all.
  for (const r of all) {
    const gateAt = r.line.search(/\.\.\.(nutrition|medical|consentGated|photo)\b/);
    const handlerAt = r.line.search(/ledgerCtrl\.|ledgerConsentCtrl\./);
    if (gateAt > -1 && handlerAt > -1) {
      assert.ok(gateAt < handlerAt, `${r.n}: ${r.line} runs the handler before the gate`);
    }
  }
});

test('the preview route cannot write - close is a separate POST', () => {
  // previewDay writes nothing, so it is a GET and can be called on every render.
  // If a GET ever grew a side effect it would be reachable by a prefetch.
  const preview = all.find((r) => r.line.includes('/preview'));
  assert.ok(preview, 'no preview route found');
  assert.match(preview.line, /^router\.get\(/);
  const close = all.find((r) => r.line.includes('/close'));
  assert.match(close.line, /^router\.post\(/);
});

// The missing-food request endpoints live inside the food picker, so they carry
// exactly the gate `/ledger/foods` carries and no other. Asserted as their own
// pair rather than added to the prefix list above because that sweep matches by
// prefix and `/ledger/food-requests` is not a sub-path of `/ledger/foods` - a
// route added there would have passed every other test in this file while being
// reachable without nutrition consent, which is exactly the gap this file exists
// to close.
test('the missing-food request routes are on the nutrition gate', () => {
  const requestRoutes = all.filter((r) => r.line.includes('/ledger/food-requests'));
  assert.equal(requestRoutes.length, 2, 'expected create and list');

  for (const r of requestRoutes) {
    assert.match(
      r.line,
      /\.\.\.nutrition\b/,
      `${r.n}: ${r.line} is not on the nutrition gate`,
    );
    assert.doesNotMatch(
      r.line,
      /\.\.\.medical\b|\.\.\.photo\b/,
      `${r.n}: ${r.line} must not be on the medical or photo gate`,
    );
  }
});

test('the request routes sit next to the picker they extend, not on the photo gate', () => {
  // A request is text typed into the food search box. There is no image in it,
  // so the photo flag must not govern it - and if it did, the empty state would
  // disappear for everyone while food photo logging was off, which is when the
  // picker is the only way to log anything.
  const list = all.find((r) => r.line.includes("/ledger/food-requests'"));
  assert.ok(list, 'no list route found');
  assert.doesNotMatch(list.line, /\.\.\.photo\b/);
  // And it must not be declared after a parameterized food route that could
  // capture it. `/ledger/food-requests` shares a prefix with nothing in this
  // router, but the ordering is pinned anyway so a future `:something` sibling
  // cannot swallow it without a test noticing.
  const requestAt = all.findIndex((r) => r.line.includes('/ledger/food-requests'));
  const paramFoodAt = all.findIndex((r) => /\/ledger\/food-(logs|saved-meals)\/:/i.test(r.line));
  if (paramFoodAt > -1) {
    assert.ok(requestAt < paramFoodAt, 'the collection route must precede any parameterized sibling');
  }
});

test('the admin request queue is on the main router and is gobhi-gated', () => {
  // Cross-file, and worth its own assertion: this route is the one place that
  // reads free-text names a user typed, so it is also the one place where a
  // missing role check would be a real disclosure rather than a missing feature.
  const healthRoutes = readFileSync(join(here, '..', 'routes', 'health.js'), 'utf8');
  const adminQueue = healthRoutes.match(/router\.get\('\/admin\/food-requests'[^;]*;/);
  assert.ok(adminQueue, 'no admin food-requests route found');
  assert.match(adminQueue[0], /requireRole\('gobhi'\)/);
  assert.doesNotMatch(adminQueue[0], /userId/, 'the queue must not be filterable or readable by user');

  const resolve = healthRoutes.match(/router\.post\('\/admin\/food-requests\/:id\/resolve'[^;]*;/);
  assert.ok(resolve, 'no admin resolve route found');
  assert.match(resolve[0], /requireRole\('gobhi'\)/);
});

test('the catalogue write routes are gobhi-gated, on the main router', () => {
  // The food loop's two admin ops: adding a curated food (the ONLY sanctioned
  // FoodItem write in the service) and refreshing the on-device matcher's
  // embeddings. Both change reference data every customer matches against, so
  // both are cross-file pins - a route that could be reached without the gobhi
  // role would let any authenticated user grow the catalogue or burn the
  // embedding budget.
  const healthRoutes = readFileSync(join(here, '..', 'routes', 'health.js'), 'utf8');

  const createFood = healthRoutes.match(/router\.post\('\/admin\/food-items'[^;]*;/);
  assert.ok(createFood, 'no admin food-items route found');
  assert.match(createFood[0], /requireRole\('gobhi'\)/);

  const refreshEmbeddings = healthRoutes.match(/router\.post\('\/admin\/food-embeddings\/refresh'[^;]*;/);
  assert.ok(refreshEmbeddings, 'no admin food-embeddings refresh route found');
  assert.match(refreshEmbeddings[0], /requireRole\('gobhi'\)/);
});

test('the matcher half is customer-facing on the nutrition gate', () => {
  // The read side is what the app pulls to match on-device, so it must be
  // reachable exactly like the picker it extends - nutrition-gated, GET, and
  // never gobhi-only. It returns embedding vectors for food names, which are
  // reference data, not a user's diet; the no-PII rule that keeps proposed
  // names out of analytics has nothing to bleed here.
  const ledgerRoutes = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');
  const matcher = ledgerRoutes.match(/router\.get\('\/ledger\/food-embeddings'[^;]*;/);
  assert.ok(matcher, 'no ledger food-embeddings route found');
  assert.match(matcher[0], /\.\.\.nutrition\b/);
  assert.doesNotMatch(matcher[0], /requireRole\('gobhi'\)/);
});

// The pause endpoints mutate the goal, which is nutrition data. They are gated
// like every other ledger route, and asserted explicitly rather than left to the
// "all ledger routes are gated" sweep above - because that sweep checks the GATE
// and not the ROUTE, and a pause route that dropped ...nutrition would still pass
// it while letting a user who revoked nutrition consent keep managing their
// scoring state.
test('the pause routes are on the nutrition gate, like the rest of the score surface', () => {
  const pauseRoutes = all.filter((r) => r.line.includes('/ledger/score/pause'));
  assert.equal(pauseRoutes.length, 3, 'expected GET, PUT and DELETE pause');

  for (const r of pauseRoutes) {
    assert.match(
      r.line,
      /\.\.\.nutrition\b/,
      `${r.n}: ${r.line} is not on the nutrition gate`,
    );
  }
});

test('the pause routes are registered before the parameterized score date route', () => {
  // Ordering, not cosmetics. `/:localDate/preview` is a path parameter, so a
  // pause route registered after it would be captured as a localDate of
  // "pause" - a 400 that looks like a client bug and is really a routing one.
  const pauseLine = all.findIndex((r) => r.line.includes('/ledger/score/pause'));
  const paramLine = all.findIndex((r) => r.line.includes('/:localDate/preview'));
  assert.ok(pauseLine > -1 && paramLine > -1, 'expected both routes to exist');
  assert.ok(
    pauseLine < paramLine,
    'the pause routes must be declared before /:localDate/preview or "pause" is read as a date',
  );
});
