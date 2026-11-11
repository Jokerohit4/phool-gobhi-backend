// The partner's member roster (GET /gym/:gymId/members): who appears, what is
// withheld, and the additive fields the partner apps use for expiry chips and the
// "not seen in a week" list. Runs the real controller against a mocked Prisma.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY);

const tables = {
  gymLink: [],
  user: [],
  gymMemberRecord: [],
  gymMemberPayment: [],
};

function applyWhere(rows, where = {}) {
  return rows.filter((row) => Object.entries(where).every(([key, cond]) => {
    if (cond !== null && typeof cond === 'object' && 'in' in cond) return cond.in.includes(row[key]);
    return row[key] === cond;
  }));
}

let listGymMembersForPartner;

test('setup: mock prisma and the gym-service ownership lookup, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          return new Proxy({}, {
            get(_target, prop) {
              if (typeof prop === 'string' && tables[prop]) {
                return { findMany: async ({ where } = {}) => applyWhere(tables[prop], where).map((r) => ({ ...r })) };
              }
              return undefined;
            },
          });
        }
      },
      Prisma: {},
    },
  });
  // fetchGymInternal reads the gym's owner from gym-service.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { partnerId: 55 } }) });
  ({ listGymMembersForPartner } = await import('../controllers/authController.js'));
});

function reset() {
  tables.gymLink = [
    { userId: 1, gymId: 7, source: 'gym_qr', removedAt: null, approvedAt: null, linkedAt: iso(40), firstVerifiedCheckinAt: null },
    { userId: 2, gymId: 7, source: 'self', removedAt: null, approvedAt: iso(20), linkedAt: iso(21), firstVerifiedCheckinAt: null },
    { userId: 3, gymId: 7, source: 'self', removedAt: null, approvedAt: null, linkedAt: iso(1), firstVerifiedCheckinAt: iso(1) },
    { userId: 4, gymId: 7, source: 'gym_qr', removedAt: iso(2), approvedAt: null, linkedAt: iso(30), firstVerifiedCheckinAt: null },
    { userId: 5, gymId: 8, source: 'gym_qr', removedAt: null, approvedAt: null, linkedAt: iso(30), firstVerifiedCheckinAt: null },
  ];
  const person = (id, name) => ({ id, name, phone: `99999000${id}`, email: `u${id}@example.com`, profileImageUrl: id === 1 ? 'https://img/1.jpg' : '', createdAt: iso(100), dateOfBirth: new Date('1990-01-01') });
  tables.user = [person(1, 'Asha Verma'), person(2, 'Ravi Kumar Singh'), person(3, 'Pending Person'), person(4, 'Removed Person'), person(5, 'Other Gym')];
  tables.gymMemberRecord = [{ gymId: 7, userId: 1, lockerNumber: 'B-12', followUpOn: '2026-11-15', amountDuePaise: 25000 }];
  tables.gymMemberPayment = [{ id: 1, gymId: 7, userId: 1, amountPaise: 150000, paidOn: '2026-10-01', validUntil: '2099-01-01' }];
}

async function call(req) {
  const out = {};
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  await listGymMembersForPartner(req, res);
  return out;
}

const partnerReq = (over = {}) => ({ user: { role: 'partner', id: 55 }, params: { gymId: '7' }, ...over });

test('only approved, active members of this gym appear', async () => {
  reset();
  const { body } = await call(partnerReq());
  assert.deepEqual(body.data.map((m) => m.id).sort(), [1, 2], 'not the pending request, the removed member, or another gym\'s member');
});

test('the roster never carries a customer phone, email or birth date', async () => {
  reset();
  const { body } = await call(partnerReq());
  const json = JSON.stringify(body);
  for (const secret of ['99999000', '@example.com', '1990-01-01']) assert.ok(!json.includes(secret), `must not expose ${secret}`);
  for (const m of body.data) {
    for (const key of ['phone', 'email', 'dateOfBirth']) assert.ok(!(key in m), `${key} must not be a roster field`);
  }
});

test('self-linked members still show first name only; gym-QR members show in full', async () => {
  reset();
  const { body } = await call(partnerReq());
  const byId = Object.fromEntries(body.data.map((m) => [m.id, m]));
  assert.equal(byId[1].name, 'Asha Verma');
  assert.equal(byId[2].name, 'Ravi');
});

test('each member carries a photo and when they became a member', async () => {
  reset();
  const { body } = await call(partnerReq());
  const byId = Object.fromEntries(body.data.map((m) => [m.id, m]));
  assert.equal(byId[1].photoUrl, 'https://img/1.jpg');
  assert.equal(byId[2].photoUrl, null, 'a blank photo is null, not an empty string');
  assert.deepEqual(new Date(byId[1].memberSince), tables.gymLink[0].linkedAt, 'a gym-QR member since the link');
  assert.deepEqual(new Date(byId[2].memberSince), tables.gymLink[1].approvedAt, 'a self-linked member since the gym approved them');
});

test('members with something recorded get expiry, locker, balance and follow-up; others do not', async () => {
  reset();
  const { body } = await call(partnerReq());
  const byId = Object.fromEntries(body.data.map((m) => [m.id, m]));
  assert.equal(byId[1].membershipStatus, 'active');
  assert.equal(byId[1].validUntil, '2099-01-01');
  assert.equal(byId[1].lockerNumber, 'B-12');
  assert.equal(byId[1].amountDue, 250);
  assert.equal(byId[1].followUpOn, '2026-11-15');
  assert.equal('membershipStatus' in byId[2], false, 'nothing recorded for member 2');
});

test('only the gym\'s own partner can read it', async () => {
  reset();
  assert.equal((await call(partnerReq({ user: { role: 'partner', id: 99 } }))).status, 403, 'another partner');
  assert.equal((await call(partnerReq({ user: { role: 'customer', id: 55 } }))).status, 403, 'not a partner');
});
