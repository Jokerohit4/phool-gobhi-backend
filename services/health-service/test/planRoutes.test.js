import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// UB4 plan routes contract tests. The /plan surface has its own gates:
// planSoftGated (GET /plan/today, GET /plan) and planGated (all mutations).
// Textual like ledgerRoutingGates.test.js: no database, no app instance.

const here = dirname(fileURLToPath(import.meta.url));
const planRoutes = readFileSync(join(here, '..', 'routes', 'plan.js'), 'utf8');
const requirePlanSrc = readFileSync(join(here, '..', 'middleware', 'requirePlan.js'), 'utf8');
const healthRoutes = readFileSync(join(here, '..', 'routes', 'health.js'), 'utf8');

// Whole statements, not lines — multi-line declarations lose their path in a line-based scan.
function routeStatements(source) {
  const out = [];
  const lines = source.split('\n');
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

const all = routeStatements(planRoutes);

// The one-plan routing matrix (Contracts · API). Two gates only: the two reads
// soft-gate (no consent check in middleware — the controller answers 200
// no_plan), everything else hard-gates on coach basic consent. The forbidden
// half is the load-bearing part: a mutation silently moved to the soft gate
// would serve 501s past the consent check once the stubs are replaced.
const PLAN_ROUTES = [
  { method: 'router.get', path: "'/plan/today'", gate: 'planSoftGated', forbidden: ['planGated'] },
  { method: 'router.get', path: "'/plan'", gate: 'planSoftGated', forbidden: ['planGated'] },
  { method: 'router.post', path: "'/plan/items/:id/complete'", gate: 'planGated', forbidden: ['planSoftGated'] },
  { method: 'router.delete', path: "'/plan/items/:id/complete'", gate: 'planGated', forbidden: ['planSoftGated'] },
  { method: 'router.post', path: "'/plan/items'", gate: 'planGated', forbidden: ['planSoftGated'] },
  { method: 'router.delete', path: "'/plan/items/:id'", gate: 'planGated', forbidden: ['planSoftGated'] },
  { method: 'router.post', path: "'/plan/settings/preview'", gate: 'planGated', forbidden: ['planSoftGated'] },
  { method: 'router.put', path: "'/plan/settings'", gate: 'planGated', forbidden: ['planSoftGated'] },
  { method: 'router.put', path: "'/plan/slots'", gate: 'planGated', forbidden: ['planSoftGated'] },
  { method: 'router.post', path: "'/plan/layers/food/early'", gate: 'planGated', forbidden: ['planSoftGated'] },
];

test('every /plan route exists on its gate, and on no other', () => {
  assert.equal(
    all.length,
    PLAN_ROUTES.length,
    `expected exactly ${PLAN_ROUTES.length} routes in routes/plan.js, found ${all.length}`,
  );
  for (const spec of PLAN_ROUTES) {
    const found = all.find(
      (r) => r.line.startsWith(`${spec.method}(${spec.path},`) && r.line.includes(spec.path),
    );
    assert.ok(found, `no ${spec.method} route for ${spec.path}`);
    assert.match(
      found.line,
      new RegExp(`\\.\\.\\.${spec.gate}\\b`),
      `${found.n}: ${found.line} is not on ${spec.gate}`,
    );
    for (const other of spec.forbidden) {
      assert.doesNotMatch(
        found.line,
        new RegExp(`\\.\\.\\.${other}\\b`),
        `${found.n}: ${found.line} must NOT be on ${other}`,
      );
    }
  }
});

test('the two gate arrays compose the existing middlewares in the right order', () => {
  // The captured group may carry a trailing comma, so strip it before matching.
  const seq = (src, name) =>
    (src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))?.[1] || '')
      .trim()
      .replace(/,\s*$/, '');
  assert.match(
    seq(requirePlanSrc, 'planGated'),
    /^requireAuth,\s*requireCoachJourney,\s*requireCoachConsent\('basic'\)$/,
  );
  const soft = seq(requirePlanSrc, 'planSoftGated');
  assert.match(soft, /^requireAuth,\s*requireCoachJourney$/);
  // The soft gate must NOT check consent — the controller turns a missing
  // consent into 200 no_plan, and a middleware 403 would make that
  // unreachable.
  assert.doesNotMatch(soft, /requireCoachConsent/);
});

test('routes/health.js mounts the plan router next to the journey router', () => {
  assert.match(healthRoutes, /router\.use\(journeyRouter\);\s*\nrouter\.use\(planRouter\);/);
});

test('the deleted ledger plan routes are gone', () => {
  const ledgerRoutes = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');
  const deleted = [
    "/ledger/plan/:localDate",
    "/ledger/plan/regenerate",
    "/ledger/plan/items'",
    "/ledger/plan/items/:id/complete",
    "/ledger/plan/items/:id'",
    "/ledger/prescription'",
    "/ledger/prescription/preview",
    "/ledger/targets/recompute",
    "/ledger/score/:localDate/preview",
  ];
  for (const path of deleted) {
    assert.doesNotMatch(ledgerRoutes, new RegExp(path), `${path} should be deleted`);
  }
});

test('the score routes are on planGated, not anyOf(nutrition, coachBasic)', () => {
  const ledgerRoutes = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');
  const scoreRoutes = [
    "/ledger/score'",
    "/ledger/score/calm",
    "/ledger/score/safety",
    "/ledger/score/calm-mode",
    "/ledger/score/pause'",
    "/ledger/score/blended",
    "/ledger/attainment",
    "/ledger/score/target",
    "/ledger/score/blended",
  ];
  for (const path of scoreRoutes) {
    // Should NOT have anyOf
    const routeLine = ledgerRoutes.split('\n').find((l) => l.includes(path) && l.startsWith('router.'));
    if (routeLine) {
      assert.doesNotMatch(routeLine, /anyOf\(/, `${path} must not use anyOf`);
      assert.match(routeLine, /\.\.\.planGated\b/, `${path} must be on planGated`);
    }
  }
});

test('appointments are on medical gate (medical_records consent)', () => {
  const ledgerRoutes = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');
  const apptRoutes = [
    "/ledger/appointments'",
    "/ledger/appointments/next",
  ];
  for (const path of apptRoutes) {
    const routeLine = ledgerRoutes.split('\n').find((l) => l.includes(path) && l.startsWith('router.'));
    if (routeLine) {
      assert.match(routeLine, /\.\.\.medical\b/, `${path} must be on medical gate`);
      assert.doesNotMatch(routeLine, /\.\.\.nutrition\b/, `${path} must not be on nutrition gate`);
    }
  }
});