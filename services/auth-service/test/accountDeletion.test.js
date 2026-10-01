// Regression (found on a device 2026-10-01): in-app "Delete account" never
// deleted anything. Both mobile apps call DELETE /api/auth/account, a route
// that did not exist (404), and even the route that did exist could not
// succeed for a real user — the bare user.delete hit a foreign key from
// RefreshToken (and three other tables) with no ON DELETE CASCADE.
// These tests pin both halves: the paths the clients call are routed to the
// delete handler behind verifyToken, and the auth-local rows are removed in
// the same transaction as the User row.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let ops;
let txCalls;
let erasureResult;
let router;
let deleteUserService;

function model(name) {
  return {
    deleteMany: (args) => ({ op: `${name}.deleteMany`, args }),
    updateMany: (args) => ({ op: `${name}.updateMany`, args }),
    delete: (args) => ({ op: `${name}.delete`, args }),
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [],
  };
}

test('setup: mock prisma + erasure fan-out, import routes and service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          return new Proxy({}, {
            get(target, prop) {
              if (prop === '$transaction') {
                return async (list) => { txCalls += 1; ops = list.map((o) => o.op + ' ' + JSON.stringify(o.args)); return list; };
              }
              if (typeof prop === 'string' && !prop.startsWith('$')) return model(prop);
              return undefined;
            },
          });
        }
      },
      Prisma: {},
    },
  });
  t.mock.module('../utils/eraseAcrossServices.js', {
    exports: { eraseUserAcrossServices: async () => erasureResult },
  });
  ({ default: router } = await import('../routes/auth.js'));
  ({ deleteUserService } = await import('../services/authService.js'));
});

function routeFor(method, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}

test('DELETE /delete and DELETE /account both exist and run verifyToken first', () => {
  for (const path of ['/delete', '/account']) {
    const layer = routeFor('delete', path);
    assert.ok(layer, `DELETE ${path} must be routed`);
    const names = layer.route.stack.map((s) => s.name);
    assert.equal(names[0], 'verifyToken', `DELETE ${path} must be auth-protected`);
    assert.equal(names[names.length - 1], 'deleteUser');
  }
});

test('the verifyToken guard rejects a request with no user id', () => {
  const guard = routeFor('delete', '/account').route.stack[0].handle;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nextCalled = false;
  guard({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('deletion removes auth-local rows and the user in one transaction', async () => {
  ops = []; txCalls = 0;
  erasureResult = { ok: true, results: [], failures: [] };
  const out = await deleteUserService(42);
  assert.equal(out.message, 'User deleted');
  assert.equal(txCalls, 1);
  const joined = ops.join('\n');
  for (const m of ['refreshToken', 'collectibleFind', 'savedAddress', 'partnerBankAccount', 'appModeHistory']) {
    assert.match(joined, new RegExp(`${m}\\.deleteMany \\{"where":\\{"userId":42\\}\\}`));
  }
  assert.match(joined, /user\.updateMany \{"where":\{"referredByUserId":42\},"data":\{"referredByUserId":null\}\}/);
  // Identity last, inside the same transaction.
  assert.match(ops[ops.length - 1], /^user\.delete \{"where":\{"id":42\}\}$/);
});

test('if any downstream erasure fails, nothing in auth-service is touched', async () => {
  ops = []; txCalls = 0;
  erasureResult = { ok: false, results: [], failures: [{ service: 'health-service' }] };
  await assert.rejects(deleteUserService(42), (err) => err.errorCode === 'ERASURE_INCOMPLETE' && err.status === 502);
  assert.equal(txCalls, 0);
});
