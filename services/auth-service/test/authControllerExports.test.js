// Guards the one failure this service cannot survive: routes/auth.js importing
// a name that controllers/authController.js does not export.
//
// ESM resolves that at module-instantiation time, so the process dies on the
// first line of startup — "SyntaxError: does not provide an export named X" —
// the container never listens on PORT, and Cloud Run fails the deploy. There
// is no partial degradation and no application log to read, which makes it
// slow to diagnose from nothing but a red deploy.
//
// This happened for real: countGymJoinedUsersByMonthInternal was defined and
// imported but never added to the export block, and auth-service-dev was
// undeployable for some time before it surfaced during an unrelated deploy.
//
// Deliberately parses the source instead of importing it. Importing would pull
// in Prisma and every service module, which needs a DATABASE_URL this test has
// no business requiring — and a test that needs a database to check a syntax
// contract is a test nobody runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every name routes/auth.js imports is actually exported', () => {
  const routes = readFileSync(new URL('../routes/auth.js', import.meta.url), 'utf8');
  const ctrl = readFileSync(new URL('../controllers/authController.js', import.meta.url), 'utf8');

  const importMatch = routes.match(
    /import \{([^}]*)\} from '\.\.\/controllers\/authController\.js';/
  );
  assert.ok(importMatch, 'routes/auth.js should import from authController');
  const imported = importMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(imported.length > 10, 'sanity check: expected a long import list');

  // Both forms count — the trailing `export { ... }` block AND any inline
  // `export const foo`. Checking only the block is what produced a false
  // positive when this was first investigated.
  const exported = new Set();
  const blockMatch = ctrl.match(/^export \{([^}]*)\};/m);
  if (blockMatch) {
    blockMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => exported.add(n));
  }
  for (const m of ctrl.matchAll(/^export (?:const|function|async function)\s+(\w+)/gm)) {
    exported.add(m[1]);
  }

  const missing = imported.filter((name) => !exported.has(name));
  assert.deepEqual(
    missing,
    [],
    'routes/auth.js imports these but authController.js does not export them, ' +
      `so the service will not start: ${missing.join(', ')}`
  );
});
