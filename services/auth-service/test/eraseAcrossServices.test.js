// The single most important property of account deletion: the User row must
// NOT be deleted unless every downstream service confirmed erasure. Getting
// this backwards strands personal data that is then both undeletable and
// undiscoverable, because the id that would have found it is gone.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let postCalls = [];
let postBehaviour = () => ({ ok: true, status: 200, json: async () => ({ data: { erased: true } }) });
let deletedUsers = [];

let eraseUserAcrossServices;
let deleteUserService;

// Stubbed at module scope, not inside a test with a t.after() restore — a
// per-test restore puts the real fetch back before the *next* test runs, so
// later tests silently make real network calls and time out. (Which is
// exactly what happened first time round.)
//
// Native fetch is stubbed rather than mocking an http library because this
// service deliberately has no axios dependency — a fact these tests caught
// the hard way when the first version of the unit imported one and would
// have crashed the service on boot.
globalThis.fetch = async (url) => {
  postCalls.push(String(url));
  return postBehaviour(String(url));
};

test('setup: import the unit once', async (t) => {
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  ({ eraseUserAcrossServices } = await import('../utils/eraseAcrossServices.js'));
  assert.equal(typeof eraseUserAcrossServices, 'function');
});

test('erasure fans out to every service that stores personal data', async () => {
  postCalls = [];
  postBehaviour = () => ({ ok: true, status: 200, json: async () => ({ data: { erased: true } }) });

  const result = await eraseUserAcrossServices(42);

  assert.equal(result.ok, true);
  assert.equal(postCalls.length, 3, 'buddy, challenge and health must all be called');
  assert.ok(postCalls.every((u) => u.endsWith('/internal/erase/42')));
  assert.ok(postCalls.some((u) => u.includes('buddy')));
  assert.ok(postCalls.some((u) => u.includes('challenge')));
  assert.ok(postCalls.some((u) => u.includes('health')));
});

test('booking and wallet are deliberately NOT called', async () => {
  postCalls = [];
  postBehaviour = () => ({ ok: true, status: 200, json: async () => ({ data: { erased: true } }) });

  await eraseUserAcrossServices(42);

  // Their rows carry no PII and are part of a financial/settlement record
  // with statutory retention — erasing them would create a different legal
  // problem than the one this solves. Asserted so a future "helpful" addition
  // has to argue with a failing test first.
  assert.ok(!postCalls.some((u) => u.includes('booking')));
  assert.ok(!postCalls.some((u) => u.includes('wallet')));
});

test('one failing service marks the whole erasure as not ok, and names it', async () => {
  postCalls = [];
  postBehaviour = (url) => {
    if (url.includes('challenge')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { erased: true } }) };
  };

  const result = await eraseUserAcrossServices(42);

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].service, 'challenge-service');
  assert.equal(result.failures[0].status, 500);
});

test('a 404 counts as a failure, not a benign miss', async () => {
  postCalls = [];
  postBehaviour = (url) => {
    if (url.includes('health')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { erased: true } }) };
  };

  const result = await eraseUserAcrossServices(42);

  // A missing route means that service is not deployed with erasure yet —
  // the data is still there. Treating it as "fine" would silently return a
  // successful deletion that didn't happen.
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].status, 404);
});

test('every service is attempted even after an earlier one fails', async () => {
  postCalls = [];
  postBehaviour = (url) => {
    if (url.includes('buddy')) throw new Error('down');
    return { ok: true, status: 200, json: async () => ({ data: { erased: true } }) };
  };

  const result = await eraseUserAcrossServices(42);

  assert.equal(postCalls.length, 3, 'a first failure must not abort the rest');
  assert.equal(result.results.length, 2);
  assert.equal(result.failures.length, 1);
});

test('deleteUserService refuses to delete the User row when erasure is incomplete', async (t) => {
  deletedUsers = [];
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            delete: async ({ where }) => {
              deletedUsers.push(where.id);
              return { id: where.id };
            },
          };
          this.$queryRaw = async () => [];
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../utils/eraseAcrossServices.js', import.meta.url).href, {
    exports: {
      eraseUserAcrossServices: async () => ({
        ok: false,
        results: [],
        failures: [{ service: 'buddy-service', status: 500, error: 'down' }],
      }),
    },
  });

  ({ deleteUserService } = await import('../services/authService.js'));

  await assert.rejects(
    () => deleteUserService(42),
    (err) => {
      assert.equal(err.errorCode, 'ERASURE_INCOMPLETE');
      assert.equal(err.status, 502);
      assert.deepEqual(err.failedServices, ['buddy-service']);
      return true;
    },
  );
  assert.deepEqual(deletedUsers, [],
      'the account must survive so the user can retry — never strand orphan data');
});
