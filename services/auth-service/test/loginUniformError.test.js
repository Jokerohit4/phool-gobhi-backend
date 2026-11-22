// Legacy email/password login: unknown user, wrong password and a null
// password hash all return the same 401 (no enumeration, no 500).
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let row = null;
let loginService;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = { findUnique: async () => row };
        }
      },
      Prisma: {},
    },
  });
  ({ loginService } = await import('../services/authService.js'));
});

const is401 = (err) => err.status === 401 && err.errorCode === 'E105';

test('unknown user -> 401', async () => {
  row = null;
  await assert.rejects(loginService({ email: 'x@y.z', password: 'pw' }), is401);
});

test('null password hash -> 401, not 500', async () => {
  row = { id: 1, password: null, isActive: true };
  await assert.rejects(loginService({ email: 'x@y.z', password: 'pw' }), is401);
});

test('wrong password -> 401', async () => {
  row = { id: 1, password: '$2a$10$abcdefghijklmnopqrstuuMq0vYqJ1zq1q1q1q1q1q1q1q1q1q1q1', isActive: true };
  await assert.rejects(loginService({ email: 'x@y.z', password: 'pw' }), is401);
});
