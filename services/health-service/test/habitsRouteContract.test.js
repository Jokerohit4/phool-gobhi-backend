import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Gating on the habits routes is checked textually, the same way
// ledgerRoutingGates.test.js and routeSplitGates.test.js check theirs: no
// database, no app instance, and it fails the moment a route loses its gate
// or gains the wrong one.
//
// The split this file exists to pin: water is layer-1 of the journey and
// rides the coach `basic` scope, while every supplement route ALSO requires
// the `supplements` scope. The negative half is load-bearing — a supplement
// route left on coachBasic alone would let someone who agreed to a plan
// silently start building a schedule of things they put in their body, which
// is exactly the consent the Contracts keep separate.

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, '..', 'routes', 'habits.js'), 'utf8');

// Whole statements, not lines — the route declarations spread their gates
// across a single line here, but the parser keeps the same shape as the other
// routing-gate tests so a multi-line declaration later cannot slip past.
function routeLines() {
  const out = [];
  const lines = routes.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('router.')) continue;
    const start = i;
    let stmt = lines[i];
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

test('every habits route is authenticated and flag-gated through a declared gate array', () => {
  // Both gate arrays begin with requireAuth (pinned below), so spreading one
  // of them is auth + flag + scope in the right order. Anything else — a bare
  // middleware list, a hand-rolled chain — is a gap.
  const ungated = all.filter(
    (r) => !/\.\.\.(coachBasic|coachSupplements)\b/.test(r.line),
  );
  assert.deepEqual(
    ungated.map((r) => `${r.n}: ${r.line}`),
    [],
    'a habits route neither spreads coachBasic nor coachSupplements',
  );
});

test('the gate arrays are shaped exactly as the contract orders them', () => {
  // Auth before flag before scope: the flag check must never run for an
  // unauthenticated caller (it leaks feature state), and the scope check
  // reads a consent row that only means anything for a known user.
  const basic = routes.match(/const coachBasic = \[([^\]]*)\]/)?.[1]?.trim();
  assert.equal(
    basic,
    "requireAuth, requireCoachJourney, requireCoachConsent('basic')",
    'coachBasic must be requireAuth + the coachJourney flag + the basic scope',
  );
  // The supplements gate is coachBasic plus the scope — spread, not restated,
  // so the two cannot drift apart.
  const supp = routes.match(/const coachSupplements = \[([^\]]*)\]/)?.[1]?.trim();
  assert.equal(supp, '...coachBasic, requireCoachConsent(\'supplements\')',
    'coachSupplements must be coachBasic plus the supplements scope, spread not restated');
});

test('water and today ride coachBasic only — never the supplements scope', () => {
  for (const fragment of [
    "router.get('/habits/today'",
    "router.post('/habits/water'",
    "router.delete('/habits/water/:id'",
  ]) {
    const found = all.filter((r) => r.line.includes(fragment));
    assert.ok(found.length === 1, `expected exactly one route for ${fragment}`);
    assert.match(found[0].line, /\.\.\.coachBasic\b/, `${found[0].n} is not on coachBasic`);
    assert.doesNotMatch(
      found[0].line,
      /\.\.\.coachSupplements\b/,
      `${found[0].n} must NOT require the supplements scope — water is layer-1 of the journey`,
    );
  }
});

test('every supplement route rides coachSupplements — the scope is not optional there', () => {
  const expected = [
    "router.get('/habits/supplements'",
    "router.post('/habits/supplements'",
    "router.put('/habits/supplements/:id'",
    "router.delete('/habits/supplements/:id'",
    "router.post('/habits/supplements/:id/taken'",
  ];
  for (const fragment of expected) {
    const found = all.filter((r) => r.line.includes(fragment));
    assert.ok(found.length === 1, `expected exactly one route for ${fragment}`);
    assert.match(
      found[0].line,
      /\.\.\.coachSupplements\b/,
      `${found[0].n} must sit behind the supplements scope, not coachBasic alone`,
    );
  }
  assert.equal(all.length, 8, `expected the 8 contract routes, found ${all.length}`);
});

test('the routes are the contract\'s routes, and nothing else', () => {
  // A new habits surface arriving without a gate decision is exactly the gap
  // the first test cannot see when it carries a valid spread. Set equality
  // makes adding one a deliberate edit here too.
  const paths = all.map((r) => r.line.match(/router\.\w+\('([^']*)'/)?.[1]).sort();
  assert.deepEqual(paths, [
    '/habits/supplements',
    '/habits/supplements',
    '/habits/supplements/:id',
    '/habits/supplements/:id',
    '/habits/supplements/:id/taken',
    '/habits/today',
    '/habits/water',
    '/habits/water/:id',
  ]);
});
