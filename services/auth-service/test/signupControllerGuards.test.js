// Public POST /signup must never mint trainer/gobhi accounts and must ignore
// a client-supplied tier. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let calls = [];
let signup;

test('setup: import controller with mocked prisma', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            create: async ({ data }) => {
              calls.push(data);
              throw new Error('stop after capture');
            },
          };
        }
      },
      Prisma: {},
    },
  });
  ({ signup } = await import('../controllers/authController.js'));
  assert.equal(typeof signup, 'function');
});

function run(body) {
  const res = {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return signup({ body }, res).then(() => res);
}

test('role trainer is rejected with 403', async () => {
  const res = await run({ name: 'x', email: 'a@b.c', password: 'p', role: 'trainer', type: 'general' });
  assert.equal(res.code, 403);
});

test('role gobhi is rejected with 403', async () => {
  const res = await run({ name: 'x', email: 'a@b.c', password: 'p', role: 'gobhi', type: 'general' });
  assert.equal(res.code, 403);
});

test('client-supplied premium tier is ignored for self-signup', async () => {
  calls = [];
  await run({ name: 'x', email: 'a@b.c', password: 'pw', role: 'customer', type: 'premium' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'general');
  assert.equal(calls[0].role, 'customer');
});
