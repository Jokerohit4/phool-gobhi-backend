import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Corporate wellness hands out other people's activity, so the access rules
// are pinned textually (same approach as routeFlagMatrix.test.js): no database,
// and it fails the moment a route loses its gate or the mount order changes.

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, '..', 'routes', 'organizations.js'), 'utf8');
const app = readFileSync(join(here, '..', 'app.js'), 'utf8');

const declared = [...routes.matchAll(/^router\.(get|post|put|patch|delete)\('([^']+)'(.*)\);$/gm)]
  .map((m) => ({ method: m[1].toUpperCase(), path: m[2], rest: m[3] }));

test('the route file declares the routes we expect, and every one parsed', () => {
  assert.ok(declared.length >= 16, `only parsed ${declared.length} routes`);
  const total = (routes.match(/^router\.(get|post|put|patch|delete)\(/gm) || []).length;
  assert.equal(declared.length, total, 'a route declaration did not parse and would escape the checks below');
});

test('every /admin route is staff-only (gobhi)', () => {
  for (const r of declared.filter((x) => x.path.startsWith('/admin/'))) {
    assert.match(r.rest, /requireRole\('gobhi'\)/, `${r.method} ${r.path} must require the gobhi role`);
  }
});

test('every /internal route needs the internal key', () => {
  for (const r of declared.filter((x) => x.path.startsWith('/internal/'))) {
    assert.match(r.rest, /requireInternal/, `${r.method} ${r.path} must require the internal key`);
  }
});

test('member routes require a signed-in user and are read-only: membership is only ever written by staff', () => {
  const member = declared.filter((x) => x.path.startsWith('/orgs/'));
  assert.ok(member.length >= 2);
  for (const r of member) {
    assert.equal(r.method, 'GET', `${r.method} ${r.path}: there must be no way for a customer to join or change a company`);
    assert.match(r.rest, /requireAuth/, `${r.method} ${r.path} must require auth`);
  }
});

test('there is no join / self-enrol / invite-code route anywhere', () => {
  assert.doesNotMatch(routes, /\/join|\/enroll|\/invite-code|\/self/i);
});

test('the router is mounted before the challenge router, whose bare /:id would shadow /orgs', () => {
  const orgs = app.indexOf("app.use('/', organizationRoutes)");
  const challenges = app.indexOf("app.use('/', challengeRoutes)");
  assert.ok(orgs !== -1 && challenges !== -1);
  assert.ok(orgs < challenges);
});
