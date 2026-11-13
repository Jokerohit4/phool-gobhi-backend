// The onboarding "how often do you train" answer (weeklyFrequencyIntent) was
// sent by the app and read by health-service's goalService, but the profile
// update handler never wrote it — so every user's first weekly target fell
// back to the neutral default. These tests pin the write path: a valid value
// round-trips into prisma.user.update and back out of the response, an
// invalid one is a 400 before any DB write, and null clears it.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// An incomplete profile (no photo) on both sides of the update, so the
// profile-completion bonus path — which calls wallet-service — never runs.
const baseUser = {
  id: 42, name: 'Test User', phone: '9990001111', email: null, gender: null,
  dateOfBirth: null, fitnessGoals: [], profileImageUrl: null, fcmToken: null,
  currentlyWorksOut: null, trainingLocationPref: null, trainingLocationOther: null,
  freeTimeWindow: null, weeklyFrequencyIntent: null, appMode: null,
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
        }
      },
      Prisma: {},
    },
  });
  ({ updateProfile } = await import('../controllers/userProfileController.js'));
  assert.equal(typeof updateProfile, 'function');
});

function reqWith(body) {
  return { headers: { 'x-user-id': '42' }, params: { userId: '42' }, body };
}

test('a valid weeklyFrequencyIntent is written and returned', async () => {
  stored = { ...baseUser };
  updateCalls = [];
  const res = fakeRes();

  await updateProfile(reqWith({ weeklyFrequencyIntent: 'five_plus' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].weeklyFrequencyIntent, 'five_plus');
  assert.equal(res.body.data.weeklyFrequencyIntent, 'five_plus');
});

test('an unknown weeklyFrequencyIntent is a 400 and nothing is written', async () => {
  stored = { ...baseUser };
  updateCalls = [];
  const res = fakeRes();

  await updateProfile(reqWith({ weeklyFrequencyIntent: 'every_day' }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /weeklyFrequencyIntent/);
  assert.equal(updateCalls.length, 0);
});

test('null clears a previously stored weeklyFrequencyIntent', async () => {
  stored = { ...baseUser, weeklyFrequencyIntent: 'one_two' };
  updateCalls = [];
  const res = fakeRes();

  await updateProfile(reqWith({ weeklyFrequencyIntent: null }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls[0].weeklyFrequencyIntent, null);
  assert.equal(res.body.data.weeklyFrequencyIntent, null);
});

test('omitting weeklyFrequencyIntent leaves the stored value alone', async () => {
  stored = { ...baseUser, weeklyFrequencyIntent: 'three_four' };
  updateCalls = [];
  const res = fakeRes();

  await updateProfile(reqWith({ name: 'Renamed' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal('weeklyFrequencyIntent' in updateCalls[0], false);
  assert.equal(res.body.data.weeklyFrequencyIntent, 'three_four');
});

test('an under-18 date of birth is rejected (18+ product)', async () => {
  stored = { ...baseUser };
  updateCalls = [];
  const res = fakeRes();
  const now = new Date();
  const seventeen = `${now.getFullYear() - 17}-01-01`;

  await updateProfile(reqWith({ dateOfBirth: seventeen }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /18/);
  assert.equal(updateCalls.length, 0);
});
