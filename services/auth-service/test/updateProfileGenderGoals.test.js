// Onboarding now requires gender, sent on the same PUT /api/users/:id call as
// fitnessGoals. These tests pin that the call accepts + validates gender, and
// that legacy persona ids from older app builds (muscle_builder, zen_seeker,
// general_fit) are mapped to FitnessGoal enum values instead of 400ing.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFitnessGoals } from '../constants/userEnums.js';

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
};

let stored;
let updateCalls;
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
        }
      },
      Prisma: {},
    },
  });
  // Buddy profile sync is fire-and-forget over fetch (this service has no
  // axios dependency); stub the global so the test never opens a socket.
  globalThis.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });
  ({ updateProfile } = await import('../controllers/userProfileController.js'));
  assert.equal(typeof updateProfile, 'function');
});

function reqWith(body) {
  return { headers: { 'x-user-id': '42' }, params: { userId: '42' }, body };
}

test('normalizeFitnessGoals maps the three legacy persona ids and dedupes', () => {
  assert.deepEqual(normalizeFitnessGoals(['muscle_builder']), ['muscle_gain']);
  assert.deepEqual(normalizeFitnessGoals(['zen_seeker']), ['flexibility_yoga']);
  assert.deepEqual(normalizeFitnessGoals(['general_fit', 'general_fitness']), ['general_fitness']);
  assert.deepEqual(normalizeFitnessGoals(['weight_loss', 'bogus']), ['weight_loss', 'bogus']);
  assert.equal(normalizeFitnessGoals(null), null);
  assert.equal(normalizeFitnessGoals('muscle_builder'), 'muscle_builder');
});

test('onboarding payload with gender + legacy persona goal is accepted and mapped', async () => {
  stored = { ...baseUser };
  updateCalls = [];
  const res = fakeRes();

  await updateProfile(reqWith({ gender: 'female', fitnessGoals: ['zen_seeker', 'muscle_builder'] }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].gender, 'female');
  assert.deepEqual(updateCalls[0].fitnessGoals, ['flexibility_yoga', 'muscle_gain']);
  assert.equal(res.body.data.gender, 'female');
});

test('every gender enum value is accepted', async () => {
  for (const g of ['male', 'female', 'other', 'prefer_not_to_say']) {
    stored = { ...baseUser };
    updateCalls = [];
    const res = fakeRes();
    await updateProfile(reqWith({ gender: g, fitnessGoals: ['general_fitness'] }), res);
    assert.equal(res.statusCode, 200, g);
    assert.equal(updateCalls[0].gender, g);
  }
});

test('an unknown gender is a 400 and nothing is written', async () => {
  stored = { ...baseUser };
  updateCalls = [];
  const res = fakeRes();
  await updateProfile(reqWith({ gender: 'Female', fitnessGoals: ['general_fitness'] }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /gender/);
  assert.equal(updateCalls.length, 0);
});

test('a genuinely unknown fitness goal is still a 400', async () => {
  stored = { ...baseUser };
  updateCalls = [];
  const res = fakeRes();
  await updateProfile(reqWith({ fitnessGoals: ['couch_potato'] }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /fitnessGoals/);
  assert.equal(updateCalls.length, 0);
});
