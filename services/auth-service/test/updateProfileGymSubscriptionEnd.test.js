// gymSubscriptionEndDate: must be a valid ISO date strictly in the future;
// null clears it; a bad or past value is a 400 before any DB write.
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
  gymSubscriptionEndDate: null,
};

let stored;
let updateCalls;
let updateProfile;

test('setup', async (t) => {
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
});

const reqWith = (body) => ({ headers: { 'x-user-id': '42' }, params: { userId: '42' }, body });
const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString();

test('a future date is written', async () => {
  stored = { ...baseUser }; updateCalls = [];
  const res = fakeRes();
  await updateProfile(reqWith({ gymSubscriptionEndDate: daysFromNow(30) }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(updateCalls[0].gymSubscriptionEndDate instanceof Date);
});

test('a past date is rejected with no write', async () => {
  stored = { ...baseUser }; updateCalls = [];
  const res = fakeRes();
  await updateProfile(reqWith({ gymSubscriptionEndDate: daysFromNow(-1) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(updateCalls.length, 0);
});

test('garbage is rejected', async () => {
  stored = { ...baseUser }; updateCalls = [];
  const res = fakeRes();
  await updateProfile(reqWith({ gymSubscriptionEndDate: 'soon' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(updateCalls.length, 0);
});

test('null clears it', async () => {
  stored = { ...baseUser, gymSubscriptionEndDate: new Date(daysFromNow(10)) }; updateCalls = [];
  const res = fakeRes();
  await updateProfile(reqWith({ gymSubscriptionEndDate: null }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalls[0].gymSubscriptionEndDate, null);
});
