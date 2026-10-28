import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { audienceForProfile, challengeMatchesAudience } from '../services/challengeAudience.js';

let count = 0, enabled = true, fail = false, current, requests;
const payments = new Map();
const prisma = {
  challengeEnrollment: {
    updateMany: async ({ data }) => {
      if (current.status === 'active') current = { ...current, ...data };
      return { count: 1 };
    },
    findUnique: async () => current,
  },
  rewardIssuance: { upsert: async () => ({}) },
};
let refreshPersonalChallenge, PERSONAL_CHALLENGES;
test('setup personal progress dependencies', async t => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class { constructor() { return prisma; } } } });
  t.mock.module(new URL('../services/coinLedgerService.js', import.meta.url).href, { exports: {
    creditCoinsService: async (userId, amount, description, key) => payments.set(key, amount),
  } });
  t.mock.module(new URL('../middleware/requireFeatureFlag.js', import.meta.url).href, { exports: { isFeatureEnabled: async () => enabled } });
  ({ refreshPersonalChallenge, PERSONAL_CHALLENGES } = await import('../services/personalChallengeService.js'));
});

beforeEach(() => {
  count = 0; enabled = true; fail = false; payments.clear(); requests = [];
  current = { id: 3, userId: 42, status: 'active', progressCount: 0, startedAt: new Date('2026-10-20T00:00:00Z') };
});
function quest() {
  return { id: 10, targetCount: 3, rewardCoins: 5, enrollments: [current],
    challengeDefinition: { type: 'water_consistency', defaultVerificationMethod: 'activity_log', audiences: ['wellness'] } };
}
async function withActivity(action) {
  const previous = global.fetch;
  global.fetch = async url => {
    requests.push(String(url));
    if (fail) throw new Error('unavailable');
    return { ok: true, json: async () => ({ data: { count } }) };
  };
  try { await action(); } finally { global.fetch = previous; }
}

test('five profile kinds and map quests keep distinct eligibility', () => {
  const cases = [
    [{ workoutIntent: 'wellness_only' }, 'wellness'], [{ appMode: 'home_track' }, 'home_training'],
    [{ trainingLocationPref: 'gym' }, 'own_gym'], [{ linkedGymId: 4 }, 'linked_gym'], [{}, 'explorer'],
  ];
  for (const [profile, audience] of cases) assert.equal(audienceForProfile(profile), audience);
  assert.equal(challengeMatchesAudience({ challengeDefinition: { category: 'gym_native' } }, 'wellness'), false);
  for (const [, audience] of cases) assert.equal(challengeMatchesAudience({ challengeDefinition: { category: 'outside_gym_city' } }, audience), true);
  assert.equal(challengeMatchesAudience(quest(), 'home_training'), false);
});

test('seed includes a tailored personal challenge for every profile kind', () => {
  for (const audience of ['wellness', 'home_training', 'own_gym', 'linked_gym', 'explorer']) {
    assert.ok(PERSONAL_CHALLENGES.some(definition => definition.audiences.includes(audience)));
  }
});

test('progress uses enrollment start, caps at target and pays once across reloads', async () => withActivity(async () => {
  count = 99;
  let result = await refreshPersonalChallenge(quest(), 42);
  assert.equal(current.progressCount, 3);
  assert.equal(current.status, 'completed');
  assert.equal(payments.size, 1);
  result = await refreshPersonalChallenge({ ...result, enrollments: [current] }, 42);
  assert.equal(payments.size, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /since=2026-10-20/);
}));

test('outages preserve progress and never manufacture completion or coins', async () => withActivity(async () => {
  current.progressCount = 1; fail = true;
  const result = await refreshPersonalChallenge(quest(), 42);
  assert.equal(result.progressUnavailable, true);
  assert.equal(current.progressCount, 1);
  assert.equal(payments.size, 0);
}));

test('pending rewards retain completed activity and can be retried when coins are enabled', async () => withActivity(async () => {
  count = 3; enabled = false;
  const result = await refreshPersonalChallenge(quest(), 42);
  assert.equal(result.rewardPending, true);
  assert.equal(current.progressCount, 3);
  assert.equal(current.status, 'active');
  enabled = true;
  await refreshPersonalChallenge(quest(), 42);
  assert.equal(current.status, 'completed');
  assert.equal(payments.size, 1);
}));

test('abandoned quests are neither advanced nor paid', async () => withActivity(async () => {
  current.status = 'abandoned'; count = 3;
  await refreshPersonalChallenge(quest(), 42);
  assert.equal(requests.length, 0);
  assert.equal(payments.size, 0);
}));

test('the persona auth-service serves wins over the old answer-based guess', () => {
  // A user who switched out of wellness keeps their wellness answers.
  assert.equal(audienceForProfile({ persona: 'home_training', workoutIntent: 'wellness_only', wellnessFocuses: ['sleep'] }), 'home_training');
  assert.equal(audienceForProfile({ persona: 'explorer', linkedGymId: null, homeUnclaimedGymId: 9 }), 'explorer');
  // Unknown values fall back to the derivation (older auth-service).
  assert.equal(audienceForProfile({ persona: 'nonsense', linkedGymId: 4 }), 'linked_gym');
});

test('a challenge joined under another persona is paused, not advanced or paid', async () => withActivity(async () => {
  count = 3;
  const result = await refreshPersonalChallenge(quest(), 42, 'home_training');
  assert.equal(result.pausedForPersona, true);
  assert.equal(requests.length, 0, 'no activity read while paused');
  assert.equal(current.progressCount, 0);
  assert.equal(payments.size, 0);
  // Back in its audience: it resumes and completes.
  await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(current.status, 'completed');
  assert.equal(payments.size, 1);
}));
