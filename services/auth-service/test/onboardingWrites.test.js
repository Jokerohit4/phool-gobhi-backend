// B1 acceptance — the new onboarding writes accepted by updateProfile:
//
//  - experienceLevel is saved when valid, rejected (400) when not;
//  - homeUnclaimedGymId takes a positive int or null, rejects anything else;
//  - firstVisitBadgeConsent sets the flag + timestamp on grant and clears the
//    timestamp on revoke;
//  - an under-18 date of birth returns 400 { code: 'UNDER_MIN_AGE' };
//  - the three appMode rows from the build-plan mapping table derive correctly.
//
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
  linkedGymId: null, experienceLevel: null, homeUnclaimedGymId: null,
  firstVisitBadgeConsent: false, firstVisitBadgeConsentAt: null,
};

let stored;
let updateCalls;
let historyRows;
let updateProfile;

test('setup: mock @prisma/client once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            findUnique: async () => (stored ? { ...stored } : null),
            update: async ({ data }) => { updateCalls.push(data); stored = { ...stored, ...data }; return { ...stored }; },
          };
          this.appModeHistory = {
            create: async ({ data }) => { historyRows.push(data); return data; },
          };
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

function reset(overrides = {}) {
  stored = { ...baseUser, ...overrides };
  updateCalls = [];
  historyRows = [];
}

function dateOnly(yearsAgo) {
  return new Date(Date.now() - yearsAgo * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

test('a valid experienceLevel is saved', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ experienceLevel: 'restarting_after_break' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(stored.experienceLevel, 'restarting_after_break');
});

test('an invalid experienceLevel is a 400 and nothing is written', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ experienceLevel: 'olympian' }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /experienceLevel/);
  assert.equal(updateCalls.length, 0);
});

test('homeUnclaimedGymId accepts a positive int and null, rejects garbage', async () => {
  reset();
  const ok = fakeRes();
  await updateProfile(reqWith({ homeUnclaimedGymId: 7 }), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(stored.homeUnclaimedGymId, 7);

  const cleared = fakeRes();
  await updateProfile(reqWith({ homeUnclaimedGymId: null }), cleared);
  assert.equal(cleared.statusCode, 200);
  assert.equal(stored.homeUnclaimedGymId, null);

  const bad = fakeRes();
  await updateProfile(reqWith({ homeUnclaimedGymId: -3 }), bad);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /homeUnclaimedGymId/);
});

test('firstVisitBadgeConsent grants (sets the timestamp) then revokes (clears it)', async () => {
  reset();
  const grab = fakeRes();
  await updateProfile(reqWith({ firstVisitBadgeConsent: true }), grab);
  assert.equal(grab.statusCode, 200);
  assert.equal(stored.firstVisitBadgeConsent, true);
  assert.ok(stored.firstVisitBadgeConsentAt instanceof Date, 'grant stamps the consent time');

  const revoke = fakeRes();
  await updateProfile(reqWith({ firstVisitBadgeConsent: false }), revoke);
  assert.equal(revoke.statusCode, 200);
  assert.equal(stored.firstVisitBadgeConsent, false);
  assert.equal(stored.firstVisitBadgeConsentAt, null);
});

test('firstVisitBadgeConsent must be a boolean', async () => {
  reset();
  const res = fakeRes();
  await updateProfile(reqWith({ firstVisitBadgeConsent: 'yes' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /firstVisitBadgeConsent/);
});

test('an under-18 date of birth is a 400 with code UNDER_MIN_AGE', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ dateOfBirth: dateOnly(10) }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'UNDER_MIN_AGE');
  assert.equal(updateCalls.length, 0);
});

test('an adult date of birth is accepted', async () => {
  reset();
  const res = fakeRes();

  await updateProfile(reqWith({ dateOfBirth: dateOnly(30) }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(stored.dateOfBirth, new Date(dateOnly(30)));
});

// The three appMode rows of the build-plan mapping table. Note: the doc's first
// row ("member of a gym" -> gym_seeker) is stale on this branch — commit 9b8e59a
// deliberately made everyone who already trains derive home_track, and
// test/appModeService.test.js pins that. Only the "not a member, prefers home"
// row changes here (B1 step 4: false + home -> home_track).
test('appMode row: not a member, wants a gym -> gym_seeker', async () => {
  reset();
  const res = fakeRes();
  await updateProfile(reqWith({ currentlyWorksOut: false, trainingLocationPref: 'gym' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'gym_seeker');
});

test('appMode row: not a member, prefers home -> home_track', async () => {
  reset();
  const res = fakeRes();
  await updateProfile(reqWith({ currentlyWorksOut: false, trainingLocationPref: 'home' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'home_track');
});

test('appMode row: already trains (at a gym) -> home_track', async () => {
  reset();
  const res = fakeRes();
  await updateProfile(reqWith({ currentlyWorksOut: true, trainingLocationPref: 'gym' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(stored.appMode, 'home_track');
});
