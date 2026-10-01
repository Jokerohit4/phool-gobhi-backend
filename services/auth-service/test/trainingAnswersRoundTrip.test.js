// Regression (found on a device 2026-10-01): the "How do you train?" answers
// came back 200 from PUT /users/:id but the app kept re-asking. The root cause
// was client-side (the app's GET mapping dropped the fields), but this pins
// the server half of the contract end to end: what the onboarding sheet PUTs
// is what GET /users/:id returns, and appMode is derived from it — so a
// future server change can't reintroduce the same symptom from this side.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// Incomplete profile (no photo) so the profile-completion bonus — a
// wallet-service call — never runs.
const baseUser = {
  id: 318, name: 'Device User', phone: '6123457890', email: null, gender: null,
  dateOfBirth: null, fitnessGoals: [], profileImageUrl: null, fcmToken: null,
  currentlyWorksOut: null, trainingLocationPref: null, trainingLocationOther: null,
  freeTimeWindow: null, weeklyFrequencyIntent: null, appMode: null,
  linkedGymId: null, leaderboardOptIn: true,
};

let stored;
let historyRows;
let getProfile;
let updateProfile;

test('setup: mock @prisma/client once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            findUnique: async () => (stored ? { ...stored } : null),
            update: async ({ data }) => { stored = { ...stored, ...data }; return { ...stored }; },
          };
          this.appModeHistory = {
            create: async ({ data }) => { historyRows.push(data); return data; },
          };
          // The handler batches update + history in a $transaction when the
          // derived mode changes; resolve the already-started operations.
          this.$transaction = async (ops) => Promise.all(ops);
        }
      },
      Prisma: {},
    },
  });
  ({ getProfile, updateProfile } = await import('../controllers/userProfileController.js'));
});

function req(body) {
  return { headers: { 'x-user-id': '318' }, params: { userId: '318' }, body };
}

test('own-gym answers PUT then GET round-trip, and appMode is derived', async () => {
  stored = { ...baseUser };
  historyRows = [];

  const put = fakeRes();
  await updateProfile(req({
    currentlyWorksOut: true,
    trainingLocationPref: 'gym',
    weeklyFrequencyIntent: 'three_four',
    freeTimeWindow: 'evening',
  }), put);
  assert.equal(put.statusCode, 200);

  const get = fakeRes();
  await getProfile(req(undefined), get);
  assert.equal(get.statusCode, 200);
  const u = get.body.data;
  assert.equal(u.currentlyWorksOut, true);
  assert.equal(u.trainingLocationPref, 'gym');
  assert.equal(u.weeklyFrequencyIntent, 'three_four');
  assert.equal(u.freeTimeWindow, 'evening');
  assert.equal(u.appMode, 'gym_seeker');
  assert.equal(historyRows.length, 1);
  assert.equal(historyRows[0].source, 'onboarding');
});

test('"No, I don\'t work out" survives the round trip as false, not null', async () => {
  stored = { ...baseUser };
  historyRows = [];

  await updateProfile(req({ currentlyWorksOut: false }), fakeRes());
  const get = fakeRes();
  await getProfile(req(undefined), get);
  assert.equal(get.body.data.currentlyWorksOut, false);
  assert.ok(get.body.data.appMode, 'a "no" answer still derives a mode');
});
