import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

const baseUser = {
  id: 42, name: 'Test User', phone: '9990001111', email: null, gender: null,
  dateOfBirth: null, fitnessGoals: [], profileImageUrl: null, fcmToken: null,
  currentlyWorksOut: null, trainingLocationPref: null, trainingLocationOther: null,
  freeTimeWindow: null, weeklyFrequencyIntent: null, appMode: null,
  recommendedEquipment: null,
};

let stored;
let updateCalls;
let updateProfile;

test('setup: mock @prisma/client once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            findUnique: async () => (stored ? { ...stored } : null),
            update: async ({ data }) => {
              updateCalls.push(data);
              stored = { ...stored, ...data };
              return { ...stored };
            },
          };
          this.appModeHistory = { create: async ({ data }) => data };
          this.$transaction = async (ops) => Promise.all(ops);
        }
      },
      Prisma: {},
    },
  });
  ({ updateProfile } = await import('../controllers/userProfileController.js'));
});

function reqWith(body) {
  return { headers: { 'x-user-id': '42' }, params: { userId: '42' }, body };
}

function reset(user = {}) {
  stored = { ...baseUser, ...user };
  updateCalls = [];
}

test('a valid id list is stored and echoed back', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ recommendedEquipment: [3, 1, 7] }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(stored.recommendedEquipment, [3, 1, 7]);
  assert.deepEqual(res.body.data.recommendedEquipment, [3, 1, 7]);
});

test('null clears the list', async () => {
  reset({ recommendedEquipment: [1, 2] });
  const res = fakeRes();

  await updateProfile(reqWith({ recommendedEquipment: null }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.recommendedEquipment, null);
  assert.equal(res.body.data.recommendedEquipment, null);
});

test('absent field writes nothing', async () => {
  reset({ recommendedEquipment: [5] });
  const res = fakeRes();

  await updateProfile(reqWith({ name: 'New Name' }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(stored.recommendedEquipment, [5]);
  assert.equal(updateCalls[0].recommendedEquipment, undefined);
});

test('non-integer entries are a 400 and nothing is written', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ recommendedEquipment: [1, 'barbell'] }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /recommendedEquipment/);
  assert.equal(updateCalls.length, 0);
});

test('negative entries are a 400 and nothing is written', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ recommendedEquipment: [-1] }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(updateCalls.length, 0);
});

test('more than 20 items is a 400 and nothing is written', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ recommendedEquipment: Array.from({ length: 21 }, (_, i) => i) }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(updateCalls.length, 0);
});

test('a non-array value is a 400 and nothing is written', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ recommendedEquipment: 7 }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(updateCalls.length, 0);
});
