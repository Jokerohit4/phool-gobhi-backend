import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  JOURNEY,
  ALWAYS_ON_LAYER_KEYS,
  ROW_KINDS,
  DEFAULT_STEPS,
  DEFAULT_SLEEP_MIN,
  startLayerFor,
} from '../services/journey/journeyConfig.js';
import { POINTS, ROW_POINTS } from '../services/ledger/constants.js';

// UA1 scaffold: the shared files the one-plan B tasks build on. Textual for
// the routes (same reasoning as routeSplitGates/ledgerRoutingGates: no
// database, no app instance), direct imports for the pure config modules.
//
// Deliberately does NOT assert that the service stubs throw 501 — UB1–UB4
// replace them one by one, and a scaffold test that pins the placeholder
// behaviour would fail the moment a real implementation lands.

const here = dirname(fileURLToPath(import.meta.url));
const planRoutes = readFileSync(join(here, '..', 'routes', 'plan.js'), 'utf8');
const requirePlanSrc = readFileSync(join(here, '..', 'middleware', 'requirePlan.js'), 'utf8');
const healthRoutes = readFileSync(join(here, '..', 'routes', 'health.js'), 'utf8');
const migrationSql = readFileSync(
  join(here, '..', 'prisma', 'migrations', '20261017000000_one_plan', 'migration.sql'),
  'utf8',
);
const schemaPrisma = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');

// Whole statements, not lines — copied from routeSplitGates.test.js for the
// same reason: multi-line declarations lose their path in a line-based scan.
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
// half is the load-bearing part, same as the health.js split test: a mutation
// silently moved to the soft gate would serve 501s past the consent check once
// the stubs are replaced.
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
  // Mirrors the coachMedications pin in routeSplitGates: the shape is the
  // contract, not an implementation detail. The captured group may carry a
  // trailing comma (the [^\]]* greedy capture keeps it), so strip it before
  // matching the sequence.
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

// ---- The layer table -------------------------------------------------------

const EXPECTED_LAYERS = [
  { key: 'basics', consent: 'coach.basic', flags: ['coachJourney'], needsSetup: false, optionalConsent: null },
  { key: 'food', consent: 'nutrition', flags: ['healthMetrics', 'healthLedger'], needsSetup: true, optionalConsent: null },
  { key: 'body', consent: null, flags: ['coachJourney'], needsSetup: false, optionalConsent: 'device_health' },
  { key: 'supplements', consent: 'coach.supplements', flags: ['coachJourney'], needsSetup: false, optionalConsent: null },
  { key: 'health', consent: 'medical_records', flags: ['healthMetrics', 'healthLedger'], needsSetup: false, optionalConsent: null },
];

test('the layer table has 5 layers with the contract consent scopes and flags', () => {
  assert.equal(JOURNEY.layers.length, 5, 'the journey must have exactly 5 layers');
  for (const expected of EXPECTED_LAYERS) {
    const layer = JOURNEY.layers.find((l) => l.key === expected.key);
    assert.ok(layer, `layer ${expected.key} is missing from JOURNEY.layers`);
    const scope = layer.consent?.scope ?? null;
    assert.equal(scope, expected.consent, `layer ${expected.key} has the wrong consent scope`);
    assert.deepEqual(layer.flags, expected.flags, `layer ${expected.key} has the wrong flags`);
    assert.equal(layer.needsSetup === true, expected.needsSetup, `layer ${expected.key} needsSetup`);
    assert.equal(
      layer.optionalConsent?.scope ?? null,
      expected.optionalConsent,
      `layer ${expected.key} optionalConsent`,
    );
  }
});

test('the always-on keys, row kinds and default targets are in place', () => {
  assert.deepEqual(ALWAYS_ON_LAYER_KEYS, ['own', 'medicine']);
  assert.deepEqual(
    [...ROW_KINDS].sort(),
    ['doctor', 'food', 'own', 'rest', 'sleep', 'steps', 'supplement', 'water', 'workout'],
  );
  assert.equal(DEFAULT_STEPS, 6000);
  assert.equal(DEFAULT_SLEEP_MIN, 420);
  assert.equal(startLayerFor('new_to_gym'), 1);
  assert.equal(startLayerFor('restarting_after_break'), 2);
  assert.equal(startLayerFor('experienced'), 5);
  assert.equal(startLayerFor('unknown'), 1, 'unknown levels fall back to layer 1');
});

test('each layer maps to its contract row layerKeys', () => {
  // Pin the Row layerKeys column of the Layers table. Note these are layer
  // keys, not wire row kinds: the supplements LAYER is keyed 'supplements'
  // while its row kind on the wire is 'supplement'.
  const expected = {
    basics: ['workout', 'water'],
    food: ['food'],
    body: ['steps', 'sleep'],
    supplements: ['supplements'],
    health: ['health'],
  };
  for (const [key, layerKeys] of Object.entries(expected)) {
    const layer = JOURNEY.layers.find((l) => l.key === key);
    assert.deepEqual(layer.layerKeys, layerKeys, `layer ${key} row layerKeys changed`);
  }
});

// ---- ROW_POINTS ------------------------------------------------------------

test('ROW_POINTS is exactly the POINTS values, not a second table', () => {
  assert.deepEqual(ROW_POINTS, {
    workout: POINTS.plannedWorkoutDone,
    rest: POINTS.restDayHonoured,
    habit: POINTS.habitDone,
    doctor: POINTS.doctorItemDone,
    foodProtein: POINTS.proteinMet,
    foodCalories: POINTS.caloriesOnTarget,
    foodMeals: POINTS.allMealsLogged,
  });
});

// ---- The migration ---------------------------------------------------------

test('the one_plan migration adds PlanItem.sourceRef and its index', () => {
  assert.match(
    migrationSql,
    /ALTER TABLE "health"\."PlanItem" ADD COLUMN(?: IF NOT EXISTS)? "sourceRef" TEXT;/,
    'migration must add PlanItem.sourceRef',
  );
  assert.match(
    migrationSql,
    /CREATE INDEX(?: IF NOT EXISTS)? "PlanItem_userId_sourceRef_idx" ON "health"\."PlanItem"\("userId", "sourceRef"\);/,
    'migration must create the (userId, sourceRef) index',
  );
});

test('the schema declares sourceRef and the matching index on PlanItem', () => {
  const body = schemaPrisma.match(/model PlanItem \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(body, 'model PlanItem not found in schema.prisma');
  assert.match(body, /^\s+sourceRef\s+String\?/m, 'PlanItem.sourceRef String? is missing');
  assert.match(body, /@@index\(\[userId, sourceRef\]\)/, 'PlanItem (userId, sourceRef) index is missing');
});

// ---- The stubs (shape only, never invoked) ---------------------------------

test('the plan service stubs export the signatures the B tasks will replace', () => {
  // typeof only — calling them throws 501 today and simply works after UB1–4,
  // and this test must keep passing across that whole transition.
  const check = (source, names) => {
    for (const name of names) {
      assert.match(
        source,
        new RegExp(`export (?:async )?function ${name}\\b|export const ${name}\\b`),
        `${name} is not exported`,
      );
    }
  };
  check(readFileSync(join(here, '..', 'services', 'plan', 'rebuildPlan.js'), 'utf8'), ['rebuildPlan']);
  check(readFileSync(join(here, '..', 'services', 'plan', 'rowProgress.js'), 'utf8'), ['resolveDay']);
  check(readFileSync(join(here, '..', 'services', 'plan', 'layerState.js'), 'utf8'), ['getLayers', 'getOnLayerKeys']);
  check(readFileSync(join(here, '..', 'services', 'plan', 'todayService.js'), 'utf8'), ['buildToday', 'buildPlanDefinition']);
});
