// Adding a trainer by phone: a number that already belongs to any account is a
// 409 (never a second account), including when two requests race past the
// lookup and the database's unique-phone rule is what stops the second one.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let users = []; // rows currently in the "database"
let beforeCreate = null; // hook to simulate a concurrent insert
let created = [];

// assertPartnerOwnsGym -> fetchGymInternal reads gym-service over native fetch.
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { id: 7, partnerId: 1 } }),
});

let createTrainerService;

test('setup: mock prisma, import authService once', async (t) => {
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            findUnique: async ({ where }) =>
              users.find((u) => u.phone === where.phone) ?? null,
            create: async ({ data }) => {
              if (beforeCreate) beforeCreate();
              if (users.some((u) => u.phone === data.phone)) {
                throw Object.assign(new Error('unique'), { code: 'P2002' });
              }
              const row = { id: 100 + users.length, isActive: true, createdAt: new Date(), ...data };
              users.push(row);
              created.push(row);
              return row;
            },
          };
        }
      },
      Prisma: {},
    },
  });
  ({ createTrainerService } = await import('../services/authService.js'));
  assert.equal(typeof createTrainerService, 'function');
});

const reset = () => {
  users = [];
  created = [];
  beforeCreate = null;
};

test('a new number becomes a trainer at that gym', async () => {
  reset();
  const t = await createTrainerService({ name: 'Asha', phone: '9876543210' }, 7, 1);
  assert.equal(t.name, 'Asha');
  assert.equal(created[0].role, 'trainer');
  assert.equal(created[0].trainerGymId, 7);
});

for (const role of ['customer', 'partner', 'gobhi']) {
  test(`a number already registered as a ${role} is refused with 409`, async () => {
    reset();
    users = [{ id: 5, phone: '9876543210', role }];
    await assert.rejects(
      createTrainerService({ name: 'Asha', phone: '9876543210' }, 7, 1),
      (e) => e.status === 409 && e.error.includes(`already registered as a ${role}`),
    );
    assert.equal(created.length, 0);
  });
}

test('a number that is already a trainer says so', async () => {
  reset();
  users = [{ id: 5, phone: '9876543210', role: 'trainer' }];
  await assert.rejects(
    createTrainerService({ name: 'Asha', phone: '9876543210' }, 7, 1),
    (e) => e.status === 409 && /already registered as a trainer/.test(e.error),
  );
});

test('losing a race to the unique-phone rule is a 409, not a 500', async () => {
  reset();
  // The lookup finds nothing, then another request inserts the number just
  // before our insert runs.
  beforeCreate = () => users.push({ id: 9, phone: '9876543210', role: 'customer' });
  await assert.rejects(
    createTrainerService({ name: 'Asha', phone: '9876543210' }, 7, 1),
    (e) => e.status === 409 && e.error.includes('already registered as a customer'),
  );
});

test('an unrelated database failure is not disguised as a 409', async () => {
  reset();
  beforeCreate = () => {
    throw Object.assign(new Error('connection lost'), { code: 'P1001' });
  };
  await assert.rejects(
    createTrainerService({ name: 'Asha', phone: '9876543210' }, 7, 1),
    (e) => e.code === 'P1001',
  );
});
