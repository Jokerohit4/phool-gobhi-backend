// linkedGymId on the profile update: the one field this handler returns but
// used to refuse.
//
// The customer app's join-link deep link calls PUT /api/users/:userId with
// {linkedGymId: gymId} (deep_link_service.dart _handleJoinGymId) when someone
// already signed in follows a gym's poster QR. The handler destructured the body
// without this field and never added it to `updates`, so the request returned
// 200 and the value was silently discarded. The app's success path clears its
// pending gym id on that 200, so the attribution was lost with nothing to show
// it had been.
//
// Pinned here:
//  - a null linkedGymId on an unlinked user is written (the bug being fixed);
//  - it is immutable once set - a second scan of another gym's poster is
//    ignored, matching issueSessionForUser, so a user cannot be reassigned to
//    a different gym by resaving their profile;
//  - a nonsense value is not written rather than 400ing, matching the
//    resolve-then-ignore shape issueSessionForUser uses for the same field.
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
  freeTimeWindow: null, weeklyFrequencyIntent: null, appMode: null, linkedGymId: null,
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

test('a join-link linkedGymId is written for a user who has none', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ linkedGymId: 7 }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.linkedGymId, 7, 'the value the app sent must not be dropped');
});

test('linkedGymId is immutable once set - a different gym is ignored', async () => {
  // The immutability is the point of the guard: without it, anyone who later
  // edits an unrelated profile field while sending the full body back could be
  // moved onto another gym, which would silently rewrite join attribution.
  reset({ linkedGymId: 7 });
  const res = fakeRes();

  await updateProfile(reqWith({ linkedGymId: 9, name: 'Renamed' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.linkedGymId, 7);
  assert.equal(stored.name, 'Renamed', 'unrelated fields still save');
  assert.equal(updateCalls[0].linkedGymId, undefined, 'and the reassignment is not attempted');
});

test('resending the same linkedGymId is a no-op rather than a rewrite', async () => {
  reset({ linkedGymId: 7 });
  const res = fakeRes();

  await updateProfile(reqWith({ linkedGymId: 7 }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls[0].linkedGymId, undefined);
});

test('a nonsense linkedGymId is ignored, not written', async () => {
  // Mirrors issueSessionForUser, which resolves the same field and drops it when
  // it is not a positive integer. A 400 here would break a client that
  // round-trips whatever it read back.
  for (const bad of ['abc', 0, -3, 1.5, null]) {
    reset();
    const res = fakeRes();

    await updateProfile(reqWith({ linkedGymId: bad }), res);

    assert.equal(res.statusCode, 200, `linkedGymId ${JSON.stringify(bad)} should not 400`);
    assert.equal(stored.linkedGymId, null, `linkedGymId ${JSON.stringify(bad)} should not be stored`);
    assert.equal(updateCalls[0].linkedGymId, undefined, `linkedGymId ${JSON.stringify(bad)} should not reach the write`);
  }
});

test('linkedGymId still round-trips in the response', async () => {
  reset({ linkedGymId: 7 });
  const res = fakeRes();

  await updateProfile(reqWith({ name: 'Renamed' }), res);

  assert.equal(res.body.data.linkedGymId, 7);
});