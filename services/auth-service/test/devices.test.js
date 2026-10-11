// Device registry (coach-journey B1). POST /devices upserts an install for the
// signed-in user and is idempotent on (userId, installId); the two internal
// reads list the other side of that relation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

let rows;
let nextId;
let registerDevice;
let getUsersForInstall;
let getDevicesForUser;

test('setup: mock @prisma/client once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.userDevice = {
            upsert: async ({ where, update, create }) => {
              const { userId, installId } = where.userId_installId;
              let row = rows.find((r) => r.userId === userId && r.installId === installId);
              if (row) {
                Object.assign(row, update);
                return { ...row };
              }
              row = {
                id: nextId++, userId, installId,
                platform: create.platform ?? null,
                firstSeenAt: new Date(), lastSeenAt: new Date(),
              };
              rows.push(row);
              return { ...row };
            },
            findMany: async ({ where }) => rows.filter((r) => (
              (where.installId === undefined || r.installId === where.installId)
              && (where.userId === undefined || r.userId === where.userId)
            )),
          };
        }
      },
      Prisma: {},
    },
  });
  ({ registerDevice, getUsersForInstall, getDevicesForUser } = await import('../controllers/deviceController.js'));
});

function reset() {
  rows = [];
  nextId = 1;
}

function postReq(body, userId = 7) {
  return { headers: userId ? { 'x-user-id': String(userId) } : {}, body };
}

test('registering an install stores it and is idempotent on (userId, installId)', async () => {
  reset();
  const first = fakeRes();
  await registerDevice(postReq({ installId: 'install-abc', platform: 'android' }), first);
  assert.equal(first.statusCode, 204);
  assert.equal(first.ended, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 7);
  assert.equal(rows[0].installId, 'install-abc');

  const second = fakeRes();
  await registerDevice(postReq({ installId: 'install-abc', platform: 'android' }), second);
  assert.equal(second.statusCode, 204);
  assert.equal(rows.length, 1, 'the same install must not create a second row');
  assert.equal(rows[0].id, 1);
});

test('a different install for the same user is a separate row', async () => {
  reset();
  await registerDevice(postReq({ installId: 'a' }), fakeRes());
  await registerDevice(postReq({ installId: 'b' }), fakeRes());
  assert.equal(rows.length, 2);
});

test('registering an install requires an installId', async () => {
  reset();
  const res = fakeRes();
  await registerDevice(postReq({ platform: 'ios' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(rows.length, 0);
});

test('registering without a user id is a 401', async () => {
  reset();
  const res = fakeRes();
  await registerDevice(postReq({ installId: 'x' }, null), res);
  assert.equal(res.statusCode, 401);
  assert.equal(rows.length, 0);
});

test('the internal reads return the user ids for an install and install ids for a user', async () => {
  reset();
  await registerDevice(postReq({ installId: 'shared' }, 7), fakeRes());
  await registerDevice(postReq({ installId: 'shared' }, 8), fakeRes());
  await registerDevice(postReq({ installId: 'only-8' }, 8), fakeRes());

  const byInstall = fakeRes();
  await getUsersForInstall({ params: { installId: 'shared' } }, byInstall);
  assert.equal(byInstall.statusCode, 200);
  assert.deepEqual([...byInstall.body.userIds].sort(), [7, 8]);

  const byUser = fakeRes();
  await getDevicesForUser({ params: { id: '8' } }, byUser);
  assert.equal(byUser.statusCode, 200);
  assert.deepEqual([...byUser.body.installIds].sort(), ['only-8', 'shared']);
});
