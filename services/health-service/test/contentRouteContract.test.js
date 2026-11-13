import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Gating on the content routes is checked textually, the same way
// habitsRouteContract.test.js checks its own: no database, no app instance.
//
// The negative half matters most: an admin route left on `reader` would let
// any signed-in user rewrite or approve coach content, which is the exact
// hole the review gate exists to close.

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, '..', 'routes', 'content.js'), 'utf8');
const controller = readFileSync(join(here, '..', 'controllers', 'contentController.js'), 'utf8');

const lines = routes.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('router.'));

test('gate arrays are exactly as declared', () => {
  assert.equal(routes.match(/const reader = \[([^\]]*)\]/)?.[1]?.trim(), 'requireAuth');
  assert.equal(routes.match(/const admin = \[([^\]]*)\]/)?.[1]?.trim(), "requireRole('gobhi')");
});

test('every /content/admin route uses the admin gate, every other one the reader gate', () => {
  assert.ok(lines.length >= 8, 'expected the 8 content routes');
  for (const l of lines) {
    if (l.includes("'/content/admin/")) assert.match(l, /\.\.\.admin\b/, l);
    else assert.match(l, /\.\.\.reader\b/, l);
  }
});

test('approve and reject exist and the reviewer comes from the JWT, not the body', () => {
  assert.ok(lines.some((l) => l.includes("'/content/admin/:type/:id/approve'")));
  assert.ok(lines.some((l) => l.includes("'/content/admin/:type/:id/reject'")));
  assert.match(controller, /reviewerId: req\.userId/);
  assert.doesNotMatch(controller, /req\.body\??\.reviewedBy/);
});
