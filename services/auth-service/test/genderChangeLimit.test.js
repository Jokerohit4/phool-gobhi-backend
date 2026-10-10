// W5: the gender-change limit. A user may make one "real" gender change (the
// old gender was set and the new one differs). Onboarding (empty -> value) and
// re-saving the same value don't count. A first real change records
// genderChangedAt/genderChangedTo inside `updates`; a second is refused with
// 400 GENDER_CHANGE_LIMIT. Because the two fields ride inside `updates`, the
// profile-completion-bonus rollback reverts them too.
// Run with: node --experimental-test-module-mocks --test
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
  genderChangedAt: null, genderChangedTo: null,
};

let stored;
let updateCalls;
let fetchImpl = async () => ({ ok: true, status: 204, json: async () => ({}) });
let updateProfile;

test('setup: mock dependencies once, import the controller once', async (t) => {
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
          // Only reached in the rollback test, where the profile crosses from
          // incomplete to complete; default amount 20 keeps the bonus enabled.
          this.profileCompletionBonusSetting = { findUnique: async () => ({ amount: 20 }) };
          this.appModeHistory = { create: async ({ data }) => data };
          this.$transaction = async (ops) => Promise.all(ops);
        }
      },
      Prisma: {},
    },
  });
  // Buddy sync + the wallet bonus are fire-and-forget HTTP; stub the global so
  // the tests never open a socket.
  globalThis.fetch = (...args) => fetchImpl(...args);
  ({ updateProfile } = await import('../controllers/userProfileController.js'));
  assert.equal(typeof updateProfile, 'function');
});

function reqWith(body) {
  return { headers: { 'x-user-id': '42' }, params: { userId: '42' }, body };
}

test('onboarding gender (empty -> value) is not a real change', async () => {
  stored = { ...baseUser };
  updateCalls = [];
  fetchImpl = async () => ({ ok: true, status: 204, json: async () => ({}) });

  const res = fakeRes();
  await updateProfile(reqWith({ gender: 'female' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls[0].gender, 'female');
  assert.equal(updateCalls[0].genderChangedAt, undefined);
  assert.equal(updateCalls[0].genderChangedTo, undefined);
});

test('re-saving the same gender is not a real change', async () => {
  stored = { ...baseUser, gender: 'female' };
  updateCalls = [];

  const res = fakeRes();
  await updateProfile(reqWith({ gender: 'female' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls[0].genderChangedAt, undefined);
  assert.equal(updateCalls[0].genderChangedTo, undefined);
});

test('the first real change records when and what', async () => {
  stored = { ...baseUser, gender: 'male' };
  updateCalls = [];

  const res = fakeRes();
  await updateProfile(reqWith({ gender: 'female' }), res);

  assert.equal(res.statusCode, 200);
  assert.ok(updateCalls[0].genderChangedAt instanceof Date, 'genderChangedAt is stamped');
  assert.equal(updateCalls[0].genderChangedTo, 'female');
});

test('a second real change is refused with GENDER_CHANGE_LIMIT and nothing is written', async () => {
  stored = { ...baseUser, gender: 'female', genderChangedAt: new Date(), genderChangedTo: 'female' };
  updateCalls = [];

  const res = fakeRes();
  await updateProfile(reqWith({ gender: 'male' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'GENDER_CHANGE_LIMIT');
  assert.match(res.body.error, /changed your gender once/i);
  assert.equal(updateCalls.length, 0);
});

test('the profile-completion-bonus rollback reverts the change stamps', async () => {
  // Incomplete only because there is no photo; the PUT also makes a real
  // gender change. When the wallet credit fails, every field in `updates`
  // must roll back — including genderChangedAt/genderChangedTo.
  stored = {
    ...baseUser,
    name: 'Test User',
    gender: 'male',
    dateOfBirth: new Date('1990-01-01'),
    fitnessGoals: ['general_fitness'],
    profileImageUrl: null,
  };
  updateCalls = [];
  fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });

  const res = fakeRes();
  await updateProfile(reqWith({ gender: 'female', profileImageUrl: 'https://img.example/x.jpg' }), res);

  assert.equal(res.statusCode, 502);
  const firstWrite = updateCalls[0];
  assert.ok(firstWrite.genderChangedAt instanceof Date, 'the first write stamps the change');
  const rollback = updateCalls[updateCalls.length - 1];
  assert.equal(rollback.genderChangedAt, null);
  assert.equal(rollback.genderChangedTo, null);
});
