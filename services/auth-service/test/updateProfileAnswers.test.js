// The onboarding answers as the Profile "How you train" editor and the
// resumable prompt write them. Pinned here:
//  - a derived appMode change is logged to AppModeHistory, 'onboarding' the
//    first time and 'settings' after, in the same transaction as the update;
//  - resending unchanged answers does NOT re-derive, so a deliberate chip
//    override survives an unrelated edit (e.g. free time);
//  - trainingLocationOther is capped and only kept next to "other".
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// No photo, so the profile-completion bonus (a wallet-service call) never runs.
const baseUser = {
  id: 42, name: 'Test User', phone: '9990001111', email: null, gender: null,
  dateOfBirth: null, fitnessGoals: [], profileImageUrl: null, fcmToken: null,
  currentlyWorksOut: null, trainingLocationPref: null, trainingLocationOther: null,
  freeTimeWindow: null, weeklyFrequencyIntent: null, appMode: null,
};

let stored;
let updateCalls;
let historyRows;
let transactions;
let updateProfile;

test('setup: mock @prisma/client once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          // Operations are applied when called, the way these tests read
          // them; $transaction just records that the pair went through it.
          this.user = {
            findUnique: async () => (stored ? { ...stored } : null),
            update: async ({ data }) => {
              updateCalls.push(data);
              stored = { ...stored, ...data };
              return { ...stored };
            },
          };
          this.appModeHistory = {
            create: async ({ data }) => { historyRows.push(data); return data; },
          };
          this.$transaction = async (ops) => { transactions += 1; return Promise.all(ops); };
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
  historyRows = [];
  transactions = 0;
}

test('the first derived mode is logged as onboarding, in one transaction', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ currentlyWorksOut: true, trainingLocationPref: 'home' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'home_track');
  assert.equal(transactions, 1);
  assert.deepEqual(historyRows, [
    { userId: 42, fromMode: null, toMode: 'home_track', source: 'onboarding' },
  ]);
});

test('changing the answer later logs the switch as settings', async () => {
  // The edit that actually moves the mode is flipping currentlyWorksOut, not
  // the training location. Any location now derives home_track (see
  // appModeService): someone already training wants a workout and progress
  // tool first, with partner-gym discovery demoted to the bottom of it.
  //
  // An earlier version of this test changed home -> gym and expected
  // gym_seeker. That expectation encoded the old rule and has outlived it, so
  // it failed against correct code. The switch being asserted here is the
  // answer edit that still changes the mode, which keeps the point of the test
  // intact: a later derivation is logged 'settings', not 'onboarding'.
  reset({ currentlyWorksOut: true, trainingLocationPref: 'home', appMode: 'home_track' });
  const res = fakeRes();

  await updateProfile(reqWith({ currentlyWorksOut: false }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'gym_seeker');
  assert.equal(transactions, 1);
  assert.deepEqual(historyRows, [
    { userId: 42, fromMode: 'home_track', toMode: 'gym_seeker', source: 'settings' },
  ]);
});

test('switching training location is no longer a mode change, and logs nothing', async () => {
  // The pair of halves to the test above, and the case that used to break.
  //
  // home -> gym derives home_track either way, so there is no switch to record.
  // Logging one would put a fabricated home_track -> home_track row in the
  // audit trail, and this log exists to answer "how did this account end up in
  // this mode" - a row that changes nothing is a worse answer than no row.
  reset({ currentlyWorksOut: true, trainingLocationPref: 'home', appMode: 'home_track' });
  const res = fakeRes();

  await updateProfile(reqWith({ trainingLocationPref: 'gym' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'home_track');
  assert.equal(transactions, 0);
  assert.equal(historyRows.length, 0);
});

test('moving gym -> home is not a mode change either', async () => {
  // Same invariant from the other direction, so the rule is pinned at both ends
  // rather than by one example that could pass for the wrong reason.
  reset({ currentlyWorksOut: true, trainingLocationPref: 'gym', appMode: 'home_track' });
  const res = fakeRes();

  await updateProfile(reqWith({ trainingLocationPref: 'home' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'home_track');
  assert.equal(historyRows.length, 0);
});

test('resending unchanged answers keeps a chip override and logs nothing', async () => {
  // Answers say home, but the user switched to gym_seeker from the chip.
  reset({ currentlyWorksOut: true, trainingLocationPref: 'home', appMode: 'gym_seeker' });
  const res = fakeRes();

  await updateProfile(reqWith({
    currentlyWorksOut: true, trainingLocationPref: 'home', freeTimeWindow: 'evening',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'gym_seeker', 'an unrelated edit must not undo the override');
  assert.equal(updateCalls[0].appMode, undefined);
  assert.equal(historyRows.length, 0);
  assert.equal(transactions, 0);
});

test('trainingLocationOther over the cap is a 400 and nothing is written', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({
    currentlyWorksOut: true, trainingLocationPref: 'other', trainingLocationOther: 'x'.repeat(81),
  }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /trainingLocationOther/);
  assert.equal(updateCalls.length, 0);
});

test('free text is trimmed and kept next to "other"', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({
    currentlyWorksOut: true, trainingLocationPref: 'other', trainingLocationOther: '  office gym  ',
  }), res);

  assert.equal(stored.trainingLocationOther, 'office gym');
});

test('switching off the "other" answer clears the stale free text', async () => {
  reset({ currentlyWorksOut: true, trainingLocationPref: 'other', trainingLocationOther: 'park', appMode: 'gym_seeker' });
  const res = fakeRes();

  await updateProfile(reqWith({ trainingLocationPref: 'home' }), res);

  assert.equal(stored.trainingLocationPref, 'home');
  assert.equal(stored.trainingLocationOther, null);
});

test('free text sent without "other" is not stored', async () => {
  reset({ currentlyWorksOut: true, trainingLocationPref: 'gym', appMode: 'gym_seeker' });
  const res = fakeRes();

  await updateProfile(reqWith({ trainingLocationOther: 'somewhere' }), res);

  assert.equal(stored.trainingLocationOther, null);
});
