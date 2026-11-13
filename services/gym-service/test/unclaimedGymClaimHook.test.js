// "Your gym joined" hook (services/unclaimedGymService.js).
//
// When an admin flips an UnclaimedGym to `claimed`, gym-service tells
// booking-service who checked in there and auth-service to prompt those
// customers to book the now-real gym. The whole point of these tests is the
// asymmetry the card calls out: the downstream notifications are best-effort,
// but the claim-status change itself must always succeed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

let updateClaimStatusService;
let notifyUnclaimedGymClaimed;

// Prisma is constructed at module scope by the service, so the client is
// mocked rather than the database (same approach as unclaimedGymMatch.test.js).
let existingRow = null;
let updateResult = null;
const updateCalls = [];
const findUniqueCalls = [];

test('setup: stub Prisma and import the service', async (t) => {
  t.mock.module('@prisma/client', {
    namedExports: {
      PrismaClient: class {
        constructor() {
          this.unclaimedGym = {
            findUnique: async (args) => {
              findUniqueCalls.push(args);
              return existingRow;
            },
            update: async (args) => {
              updateCalls.push(args);
              return updateResult ?? { ...existingRow, ...args.data, id: args.where.id };
            },
          };
          this.gym = { findMany: async () => [] };
        }
      },
    },
  });
  ({ updateClaimStatusService, notifyUnclaimedGymClaimed } = await import(
    '../services/unclaimedGymService.js'
  ));
});

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

let fetchCalls = [];
function stubFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), opts };
    fetchCalls.push(call);
    return handler(call);
  };
}

// The hook is intentionally not awaited by updateClaimStatusService, so give
// the microtask chain (booking fetch -> parse -> auth fetch) a chance to drain.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function cloudRunOk(jsonBody = {}) {
  return { ok: true, status: 200, json: async () => jsonBody };
}

test('notify: calls booking, then auth, with the customer ids', async () => {
  stubFetch((call) =>
    call.url.includes('/internal/unclaimed-gyms/')
      ? cloudRunOk({ data: { customerIds: [11, 22] } })
      : { ok: true, status: 204, json: async () => ({}) }
  );

  await notifyUnclaimedGymClaimed(7, 99);

  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].url, /\/internal\/unclaimed-gyms\/7\/customers$/);

  const auth = fetchCalls[1];
  assert.match(auth.url, /\/internal\/unclaimed-gym-claimed$/);
  assert.equal(auth.opts.method, 'POST');
  assert.deepEqual(JSON.parse(auth.opts.body), {
    unclaimedGymId: 7,
    claimedGymId: 99,
    customerIds: [11, 22],
  });
});

test('notify: accepts the bare {customerIds} envelope too', async () => {
  stubFetch((call) =>
    call.url.includes('/internal/unclaimed-gyms/')
      ? cloudRunOk({ customerIds: [5] })
      : { ok: true, status: 204, json: async () => ({}) }
  );

  await notifyUnclaimedGymClaimed(7, 99);

  assert.deepEqual(JSON.parse(fetchCalls[1].opts.body).customerIds, [5]);
});

test('notify: still pings auth with an empty list when the booking hop fails', async () => {
  stubFetch((call) =>
    call.url.includes('/internal/unclaimed-gyms/')
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, status: 204, json: async () => ({}) }
  );

  await notifyUnclaimedGymClaimed(7, 99);

  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(JSON.parse(fetchCalls[1].opts.body).customerIds, []);
});

test('a transition to claimed with a gym id fires the hook', async () => {
  existingRow = { id: 1, claimStatus: 'unclaimed', claimedGymId: null };
  updateResult = { id: 1, claimStatus: 'claimed', claimedGymId: 99 };
  updateCalls.length = 0;
  stubFetch((call) =>
    call.url.includes('/internal/unclaimed-gyms/')
      ? cloudRunOk({ data: { customerIds: [11] } })
      : { ok: true, status: 204, json: async () => ({}) }
  );

  const row = await updateClaimStatusService(1, { claimStatus: 'claimed', claimedGymId: 99 });
  await flush();

  assert.equal(row.claimStatus, 'claimed');
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].url, /\/internal\/unclaimed-gyms\/1\/customers$/);
  assert.deepEqual(JSON.parse(fetchCalls[1].opts.body), {
    unclaimedGymId: 1,
    claimedGymId: 99,
    customerIds: [11],
  });
});

test('a non-claim status change fires nothing', async () => {
  existingRow = { id: 1, claimStatus: 'unclaimed', claimedGymId: null };
  updateResult = { id: 1, claimStatus: 'claim_pending', claimedGymId: null };
  stubFetch(() => cloudRunOk());

  await updateClaimStatusService(1, { claimStatus: 'claim_pending' });
  await flush();

  assert.equal(fetchCalls.length, 0);
});

test('re-saving an already-claimed row does not re-notify', async () => {
  existingRow = { id: 1, claimStatus: 'claimed', claimedGymId: 99 };
  updateResult = { id: 1, claimStatus: 'claimed', claimedGymId: 99 };
  stubFetch(() => cloudRunOk());

  await updateClaimStatusService(1, { claimStatus: 'claimed', claimedGymId: 99 });
  await flush();

  assert.equal(fetchCalls.length, 0);
});

test('the status change resolves even when a notification throws', async () => {
  existingRow = { id: 1, claimStatus: 'unclaimed', claimedGymId: null };
  updateResult = { id: 1, claimStatus: 'claimed', claimedGymId: 99 };
  stubFetch((call) => {
    if (call.url.includes('/internal/unclaimed-gyms/')) throw new Error('booking down');
    throw new Error('auth down');
  });

  const row = await updateClaimStatusService(1, { claimStatus: 'claimed', claimedGymId: 99 });
  await flush();

  assert.equal(row.claimStatus, 'claimed');
  // Both hops were attempted despite the first one throwing.
  assert.equal(fetchCalls.length, 2);
});
