// The anyOf helper (B8): Express cannot OR two gate arrays, and the coach
// journey needs exactly that OR - the plan, score-read and prescription-read
// routes must stay reachable under the old nutrition consent AND under the
// coachJourney flag plus the coach `basic` scope.
//
// The two properties that matter, in the order the routes depend on them:
//
//   1. The SECOND gate's rejection is the one the client sees when both
//      fail. Every route wires the NEW gate first and the OLD gate second,
//      so with the coachJourney flag off the client gets exactly today's
//      error (nutrition's CONSENT_REQUIRED), never the coach gate's
//      FEATURE_DISABLED - rule 10, flag off means byte-for-byte today.
//   2. A gate's rejection is detected from what it WRITES (res.status body
//      pairs, send, sendStatus, end) or from next(err) - never by running
//      against the real response, so a rejecting gate must not leak bytes
//      to the caller before gate B has had its chance.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anyOf } from '../middleware/anyOf.js';

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

// The helper is an Express-style sync middleware that kicks off its gate
// chain without returning the promise (Express does not await one), so the
// verdict lands a few microtasks later. Awaiting a macrotask lets the whole
// chain - including gate B - finish before the assertions read it.
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function run(gateA, gateB) {
  const res = fakeRes();
  let nextCalled = false;
  anyOf(gateA, gateB)({ userId: 7 }, res, () => { nextCalled = true; });
  await tick();
  return { res, nextCalled };
}

// Representative gates, shaped like the real ones: a feature flag that
// rejects with FEATURE_DISABLED (no code - the shape requireFeatureFlag
// sends), and a consent gate that rejects with a coded CONSENT_REQUIRED.

const flagOff = (req, res, next) => {
  res.status(403).json({ error: 'FEATURE_DISABLED' });
};

const flagOn = (req, res, next) => next();

const noConsent = (code = 'CONSENT_REQUIRED') => (req, res, next) => {
  res.status(403).json({ error: 'This is off for your account.', code });
};

const consentGranted = (req, res, next) => next();

test('when the first gate passes, the second never runs', async () => {
  let bRan = false;
  const b = (req, res, next) => {
    bRan = true;
    next();
  };

  const { nextCalled } = await run(consentGranted, b);

  assert.equal(nextCalled, true);
  assert.equal(bRan, false, 'gate B ran although gate A passed');
});

test('when the first gate rejects, the second decides', async () => {
  const { nextCalled } = await run(flagOff, consentGranted);

  assert.equal(nextCalled, true, 'the request must proceed when gate B passes');
});

test('when both reject, the SECOND gate error is the one the client sees', async () => {
  // The exact flag-off shape from the routes: new gate first (FEATURE_DISABLED
  // from the coachJourney flag), old gate second. The client must see the old
  // gate's coded consent prompt, not a feature switch it has never heard of.
  const { res, nextCalled } = await run(flagOff, noConsent());

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: 'This is off for your account.',
    code: 'CONSENT_REQUIRED',
  });
});

test('the second gate rejection is sent verbatim, status and body', async () => {
  const b = (req, res, next) => {
    res.status(422).json({ error: 'odd shape', code: 'ODD', extra: true });
  };

  const { res } = await run(flagOff, b);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, { error: 'odd shape', code: 'ODD', extra: true });
});

test('a first gate that rejects does not leak its response to the client', async () => {
  // The capture must absorb A's rejection: nothing A writes may reach the
  // caller before B has answered.
  const a = (req, res, next) => {
    res.status(403).json({ error: 'FEATURE_DISABLED' });
  };

  const { res, nextCalled } = await run(a, consentGranted);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200, 'gate A wrote a status nobody sent');
  assert.equal(res.body, undefined, 'gate A wrote a body nobody sent');
});

test('an async gate is awaited, not assumed to pass', async () => {
  const asyncReject = async (req, res, next) => {
    res.status(403).json({ error: 'FEATURE_DISABLED' });
  };
  const asyncPass = async (req, res, next) => {
    next();
  };

  const passes = await run(asyncReject, asyncPass);
  assert.equal(passes.nextCalled, true, 'an async first-gate rejection must still reach gate B');

  const bothReject = await run(asyncReject, noConsent());
  assert.equal(bothReject.res.body.code, 'CONSENT_REQUIRED');
});

test('a gate that calls next(err) counts as a rejection, and gate B still runs', async () => {
  const errsNext = (req, res, next) => next(new Error('db down'));

  const { nextCalled, res } = await run(errsNext, consentGranted);
  assert.equal(nextCalled, true, 'gate B must get its chance after a next(err)');

  const { res: bothErr, nextCalled: stopped } = await run(errsNext, errsNext);
  assert.equal(stopped, false);
  assert.equal(bothErr.statusCode, 500);
});

test('a gate that throws does not hang the request', async () => {
  const throws = () => {
    throw new Error('boom');
  };

  const { res, nextCalled } = await run(throws, consentGranted);
  assert.equal(nextCalled, true, 'gate B must run after a throwing gate');

  const { res: bothBoom, nextCalled: stopped } = await run(throws, throws);
  assert.equal(stopped, false);
  assert.equal(bothBoom.statusCode, 500);
});

test('a single middleware is accepted where an array is expected', async () => {
  const { nextCalled } = await run(consentGranted, flagOn);
  assert.equal(nextCalled, true);

  const denied = await run(flagOff, noConsent());
  assert.equal(denied.res.body.code, 'CONSENT_REQUIRED');
});

test('a gate that answers with sendStatus or end is still a rejection', async () => {
  // The helper covers the refusal shapes a gate might grow into: each must
  // count as a rejection - so gate B gets its turn - rather than reading as
  // a pass.
  const sendStatusGate = (req, res, next) => {
    res.sendStatus(403);
  };
  const { nextCalled: firstGotToB } = await run(sendStatusGate, consentGranted);
  assert.equal(firstGotToB, true, 'sendStatus was read as a pass, so gate B never ran');

  const endGate = (req, res, next) => {
    res.status(403).end();
  };
  const { nextCalled: secondGotToB } = await run(endGate, consentGranted);
  assert.equal(secondGotToB, true, 'end was read as a pass, so gate B never ran');

  // And when such a gate is the surviving rejection, its captured status is
  // what the client sees.
  const { res } = await run(sendStatusGate, sendStatusGate);
  assert.equal(res.statusCode, 403);
});
