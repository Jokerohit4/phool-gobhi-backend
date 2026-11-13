// GET /users/linked-gym/:gymId — the member-scoped read of the linked-member
// home's gym (the H2 gap in docs/home-pages-launch-audit-20261008.html).
//
// The screen used to fetch its gym through the public GET /api/gyms/:id, which
// gym-service gates on isActive && isApproved && marketplaceEnabled. A partner
// running attendance-SaaS only never enables the marketplace, so their members
// — the exact people this home exists for — got a 404 and were stuck on
// "Couldn't load your gym", with check-in, score and workouts all unreachable
// behind it. This route reads gym-service's ungated /internal/:id instead, and
// only for the gym the caller is actually linked to.
//
// Pinned here:
//  - the happy path forwards to gym-service's internal read with the service
//    credentials, bypassing the marketplace gate;
//  - 404 for "no gym to show" (not linked, not yours, or the row is gone) —
//    the state the app renders as a banner;
//  - 502 when gym-service can't be reached, because a transient outage must
//    not masquerade as a permanently missing gym;
//  - a gym the caller isn't linked to is a 404, so this can't be used as a
//    general-purpose gym reader that sidesteps the public gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function gymRow(id = 7) {
  return {
    id, name: 'Iron Temple', address: '12 MG Road', city: 'Bengaluru',
    sessionPrice: 200, isActive: true, isApproved: true, marketplaceEnabled: false,
    images: [],
  };
}

let stored;
let fetchImpl;
let fetchCalls;
let getLinkedGym;

test('setup: mock @prisma/client + fetch once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            findUnique: async () => (stored ? { ...stored } : null),
          };
          this.appModeHistory = { create: async ({ data }) => data };
        }
      },
      Prisma: {},
    },
  });
  fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
  ({ getLinkedGym } = await import('../controllers/userProfileController.js'));
  assert.equal(typeof getLinkedGym, 'function');
});

function reset({ linkedGymId = 7, userExists = true } = {}) {
  stored = userExists ? { id: 42, linkedGymId } : null;
  fetchCalls = [];
  fetchImpl = async () => jsonResponse(200, { data: gymRow(linkedGymId ?? 7) });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function reqWith(gymId, userId = '42') {
  return { headers: { 'x-user-id': userId }, params: { gymId: String(gymId) } };
}

test('returns the member\'s own gym through gym-service\'s ungated internal read', async () => {
  reset();
  const res = fakeRes();

  await getLinkedGym(reqWith(7), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.id, 7);
  assert.equal(res.body.data.name, 'Iron Temple');
  assert.equal(fetchCalls.length, 1, 'exactly one gym-service lookup');
  assert.equal(fetchCalls[0].url, `${GYM_SERVICE_URL}/internal/7`);
  assert.equal(
    fetchCalls[0].opts.headers['x-internal-key'] !== undefined,
    true,
    'service-to-service calls must carry the shared internal key',
  );
  assert.equal(
    fetchCalls[0].opts.headers['x-internal-key'],
    (process.env.INTERNAL_API_KEY || '').trim(),
  );
});

test('a SaaS-only gym (marketplaceEnabled false) still comes back', async () => {
  // The whole point of the endpoint: gymService.getGymById 404s on
  // !marketplaceEnabled, which is every attendance-SaaS-only partner.
  reset();
  fetchImpl = async () => jsonResponse(200, { data: gymRow(7) });
  const res = fakeRes();

  await getLinkedGym(reqWith(7), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.marketplaceEnabled, false);
});

test('404 with no gym-service call when the caller has no linked gym', async () => {
  reset({ linkedGymId: null });
  const res = fakeRes();

  await getLinkedGym(reqWith(7), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Gym not found');
  assert.equal(fetchCalls.length, 0, 'nothing to look up');
});

test('404 for a gym the caller is not linked to', async () => {
  // Without this the route would be a general-purpose gym reader that hands
  // out exactly what the marketplace gate hides.
  reset({ linkedGymId: 7 });
  const res = fakeRes();

  await getLinkedGym(reqWith(9), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Gym not found');
  assert.equal(fetchCalls.length, 0, 'must not ask gym-service about it');
});

test('404 when gym-service no longer has the row', async () => {
  reset();
  fetchImpl = async () => jsonResponse(404, { error: 'Gym not found' });
  const res = fakeRes();

  await getLinkedGym(reqWith(7), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Gym not found');
});

test('502 when gym-service is unreachable — not a 404', async () => {
  // A banner here would tell the member their gym is gone when it is really
  // a transient outage; the app offers a retry on 502 instead.
  reset();
  fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const res = fakeRes();

  await getLinkedGym(reqWith(7), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Could not load your gym');
});

test('502 when gym-service answers with a 5xx', async () => {
  reset();
  fetchImpl = async () => jsonResponse(500, { error: 'boom' });
  const res = fakeRes();

  await getLinkedGym(reqWith(7), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Could not load your gym');
});

test('400 for a non-numeric gym id, before any lookup', async () => {
  reset();
  const res = fakeRes();

  await getLinkedGym(reqWith('abc'), res);

  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalls.length, 0);
});

test('401 when the gateway did not set an x-user-id', async () => {
  reset();
  const res = fakeRes();
  const req = { headers: {}, params: { gymId: '7' } };

  await getLinkedGym(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);
});

test('404 when the user row is gone', async () => {
  reset({ userExists: false });
  const res = fakeRes();

  await getLinkedGym(reqWith(7), res);

  assert.equal(res.statusCode, 404);
  assert.equal(fetchCalls.length, 0);
});
