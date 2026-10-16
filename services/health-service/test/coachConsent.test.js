// The coach consent surface (B8): the scopes, the grant, the revoke, and the
// two middlewares the either-gated routes lean on.
//
// The properties that matter:
//
//   1. The consent row is its own surface: `basic` is what the whole journey
//      hangs off, `supplements` is the narrow extra, and neither implies the
//      other. A revoke of one must leave the other live, and only the LAST
//      revoke sets revokedAt - a non-null revokedAt next to a live scope
//      would read as a contradiction to every reader.
//   2. The version a grant is recorded against is the version the client
//      SAW. A mismatched or missing version is refused, because a stale
//      build must not be able to record agreement to copy that was never on
//      its screen.
//   3. Revoking is idempotent and never gated: no row, already revoked,
//      twice in a row - all no-ops, never errors. "Turn this off" has to
//      keep working after an admin switches the feature off.
//   4. The gates fail CLOSED. A consent check that answers "you have not
//      consented" when the real problem is our database renders as an
//      opt-in prompt over an outage.
//
// The wiring (grant is adults-only, revoke carries no gate at all) is pinned
// textually at the bottom, the same way biometricConsent.test.js pins its
// routes - the gate-pinning sweeps in ledgerRoutingGates.test.js cover the
// array structure, and these pin the two lines the acceptance notes name.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let row = null;
let writes = [];
let service;
let COACH_POLICY_VERSION;
let BASIC_SCOPE;
let SUPPLEMENTS_SCOPE;
let rebuildCalls = [];

test('setup: stub prisma, import the service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.coachConsent = {
            findUnique: async () => row,
            upsert: async ({ create, update }) => {
              writes.push({ op: 'upsert', update });
              row = row ? { ...row, ...update } : { ...create };
              return row;
            },
            update: async ({ data }) => {
              writes.push({ op: 'update', data });
              row = { ...row, ...data };
              return row;
            },
          };
        }
      },
    },
  });

  t.mock.module('../services/plan/rebuildPlan.js', {
    exports: {
      rebuildPlan: async (prisma, userId, opts) => {
        rebuildCalls.push({ userId, opts });
        return { created: 0, updated: 0, deactivated: 0, onLayerKeys: [] };
      },
    },
  });

  service = await import('../services/coachConsentService.js');
  ({
    COACH_POLICY_VERSION,
    BASIC_SCOPE,
    SUPPLEMENTS_SCOPE,
  } = service);
});

function reset() {
  row = null;
  writes = [];
}

// ---- the read ---------------------------------------------------------------

test('no row yet is {scopes: []}, not an error and not a refusal', async () => {
  reset();
  assert.deepEqual(await service.getCoachConsentService(7), { scopes: [] });
});

test('a live row reads back with its timestamps; a revoked row reads scopes []', async () => {
  reset();
  row = {
    userId: 7,
    scopes: ['basic'],
    policyVersions: { basic: COACH_POLICY_VERSION },
    grantedAt: new Date('2026-10-01T09:00:00Z'),
    revokedAt: null,
  };
  const live = await service.getCoachConsentService(7);
  assert.deepEqual(live.scopes, ['basic']);
  assert.equal(live.revokedAt, null);

  row = { ...row, revokedAt: new Date('2026-10-02T09:00:00Z') };
  const revoked = await service.getCoachConsentService(7);
  assert.deepEqual(revoked.scopes, [], 'a revoked consent must not read as a live scope list');
  assert.ok(revoked.revokedAt);
});

// ---- the grant ----------------------------------------------------------------

test('granting records the scope under the version the client saw', async () => {
  reset();
  const out = await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });

  assert.deepEqual(out.scopes, ['basic']);
  assert.equal(out.revokedAt, null);
  assert.equal(row.policyVersions.basic, COACH_POLICY_VERSION);
});

test('a second scope merges; neither implies the other', async () => {
  reset();
  await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });
  const out = await service.grantCoachScopeService(7, 'supplements', { policyVersion: COACH_POLICY_VERSION });

  assert.deepEqual(out.scopes.sort(), ['basic', 'supplements']);
  assert.deepEqual(Object.keys(row.policyVersions).sort(), ['basic', 'supplements']);
});

test('a re-grant after a revoke clears revokedAt - history, not erasure', async () => {
  reset();
  await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });
  await service.revokeCoachScopeService(7, 'basic');
  assert.ok(row.revokedAt);

  const out = await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });
  assert.equal(out.revokedAt, null);
  assert.deepEqual(out.scopes, ['basic']);
});

test('a grant against superseded or missing wording is refused, with the current version', async () => {
  reset();
  await assert.rejects(
    () => service.grantCoachScopeService(7, 'basic', { policyVersion: '2020-01' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'COACH_POLICY_VERSION_MISMATCH');
      assert.equal(err.currentVersion, COACH_POLICY_VERSION);
      return true;
    },
  );
  await assert.rejects(
    () => service.grantCoachScopeService(7, 'basic', {}),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'COACH_POLICY_VERSION_MISMATCH');
      return true;
    },
  );
  assert.equal(row, null, 'a refused grant must not write a row');
});

test('an unknown scope is refused at grant and at revoke', async () => {
  reset();
  for (const scope of ['nutrition', 'everything', '']) {
    await assert.rejects(
      () => service.grantCoachScopeService(7, scope, { policyVersion: COACH_POLICY_VERSION }),
      (err) => err.status === 400 && err.code === 'UNKNOWN_SCOPE',
      `grant accepted "${scope}"`,
    );
    await assert.rejects(
      () => service.revokeCoachScopeService(7, scope),
      (err) => err.status === 400 && err.code === 'UNKNOWN_SCOPE',
      `revoke accepted "${scope}"`,
    );
  }
});

// ---- the revoke ----------------------------------------------------------------

test('revoking one of two scopes leaves the other live and clears only its version', async () => {
  reset();
  await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });
  await service.grantCoachScopeService(7, 'supplements', { policyVersion: COACH_POLICY_VERSION });

  const out = await service.revokeCoachScopeService(7, 'supplements');

  assert.deepEqual(out.scopes, ['basic']);
  assert.equal(out.revokedAt, null, 'basic is still live, so the consent is not revoked');
  assert.equal(row.policyVersions.supplements, undefined, 'the withdrawn scope keeps no version');
  assert.equal(row.policyVersions.basic, COACH_POLICY_VERSION);
});

test('revoking the last scope sets revokedAt', async () => {
  reset();
  await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });

  const out = await service.revokeCoachScopeService(7, 'basic');

  assert.deepEqual(out.scopes, []);
  assert.ok(out.revokedAt);
  assert.ok(row.revokedAt);
});

test('revoking is a no-op, never an error: no row, already revoked, twice', async () => {
  reset();
  const noRow = await service.revokeCoachScopeService(7, 'basic');
  assert.deepEqual(noRow.scopes, []);

  await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });
  await service.revokeCoachScopeService(7, 'basic');
  const again = await service.revokeCoachScopeService(7, 'basic');
  assert.deepEqual(again.scopes, []);
  assert.equal(writes.filter((w) => w.op === 'update').length, 1, 'the second revoke wrote again');
});

test('hasCoachScopeService: live true; revoked false; no row false', async () => {
  reset();
  assert.equal(await service.hasCoachScopeService(7, 'basic'), false);

  await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });
  assert.equal(await service.hasCoachScopeService(7, 'basic'), true);
  assert.equal(await service.hasCoachScopeService(7, 'supplements'), false, 'one scope never implies the other');

  await service.revokeCoachScopeService(7, 'basic');
  assert.equal(await service.hasCoachScopeService(7, 'basic'), false);
});

// ---- the two middlewares --------------------------------------------------------

test('the coach-journey gate: flag on passes, flag off refuses with FEATURE_DISABLED', async (t) => {
  let flagOn = false;
  await t.mock.module('../middleware/requireFeatureFlag.js', {
    exports: {
      isFeatureEnabled: async (name) => (name === 'coachJourney' ? flagOn : false),
      requireFeatureFlag: () => async (req, res, next) => next(),
      requireAnyFeatureFlag: () => async (req, res, next) => next(),
      isAnyFeatureEnabled: async () => false,
    },
  });
  const { requireCoachJourney } = await import('../middleware/requireCoachJourney.js');

  flagOn = true;
  let nextCalled = false;
  const passRes = { status: () => { throw new Error('flag-on must not reject'); }, json: () => {} };
  await requireCoachJourney({ userId: 7 }, passRes, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  flagOn = false;
  nextCalled = false;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await requireCoachJourney({ userId: 7 }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'FEATURE_DISABLED' });
});

test('the coach-consent gate: scope live passes, missing refuses, outage fails closed', async (t) => {
  let scopeLive = false;
  let boom = false;
  await t.mock.module('../services/coachConsentService.js', {
    exports: {
      hasCoachScopeService: async () => {
        if (boom) throw new Error('db down');
        return scopeLive;
      },
      BASIC_SCOPE: 'basic',
      SUPPLEMENTS_SCOPE: 'supplements',
      COACH_SCOPES: ['basic', 'supplements'],
      getCoachConsentService: async () => ({ scopes: [] }),
      grantCoachScopeService: async () => ({}),
      revokeCoachScopeService: async () => ({}),
    },
  });
  const mod = await import('../middleware/requireCoachConsent.js');
  const gate = mod.requireCoachConsent('basic');

  scopeLive = true;
  let nextCalled = false;
  await gate({ userId: 7 }, { status: () => { throw new Error('must not reject'); }, json: () => {} }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  scopeLive = false;
  nextCalled = false;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await gate({ userId: 7 }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'CONSENT_REQUIRED');

  boom = true;
  nextCalled = false;
  const down = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await gate({ userId: 7 }, down, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'a consent outage must not read as "you have not consented"');
  assert.equal(down.statusCode, 503);
});

// ---- the wiring the acceptance notes name ---------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');

test('granting is adults-only; revoking carries no gate at all', () => {
  // "Under-18 can't grant" is requireAdult on the POST (the middleware's own
  // UNDER_MIN_AGE / DOB_REQUIRED behaviour is pinned in requireAdult.test.js;
  // this pins that the route actually runs it). "Revoke always works" is the
  // DELETE with requireAuth and nothing else - not the flag, not a scope, not
  // the age gate.
  const routes = read('routes', 'ledger.js');
  assert.match(routes, /router\.post\('\/coach-consent', \.\.\.coachGated, requireAdult, coachConsentCtrl\.grantConsent\)/);
  assert.match(routes, /router\.delete\('\/coach-consent\/:scope', requireAuth, coachConsentCtrl\.revokeConsent\)/);
});

test('the coach routes read the same flag the prescription/plan context reads (B7 handoff)', () => {
  // B7's ledgerController gates its `journey` context on the coachJourney
  // flag; requireCoachJourney must check the SAME flag through the SAME
  // helper, or a route could be reachable with a plan served without the
  // journey context (or the reverse).
  const routes = read('routes', 'ledger.js');
  assert.match(routes, /const coachGated = \[requireAuth, requireCoachJourney\]/);
  const middleware = read('middleware', 'requireCoachJourney.js');
  assert.match(middleware, /isFeatureEnabled\('coachJourney'\)/);
  const controller = read('controllers', 'ledgerController.js');
  assert.match(controller, /isFeatureEnabled\('coachJourney'\)/);
});

test('consent grant triggers rebuildPlan with reason consent', async () => {
  reset();
  rebuildCalls = [];
  await service.grantCoachScopeService(7, 'basic', { policyVersion: COACH_POLICY_VERSION });
  assert.equal(rebuildCalls.length, 1);
  assert.equal(rebuildCalls[0].userId, 7);
  assert.equal(rebuildCalls[0].opts.reason, 'consent');
});
