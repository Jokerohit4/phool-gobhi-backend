// The "How they train" line: what onboarding told us, as the coach reads it.
// Run with: node --experimental-test-module-mocks --test
//
// Pinned: a home trainee is told apart from a gym-goer (the whole reason this
// line exists), "not yet" is an answer rather than silence, unknown or free
// text never reaches the provider, and the line is deterministic so the
// cached prompt prefix survives between turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let summariseTrainingProfile;

test('setup: stub Prisma, import the service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class {}, Prisma: {} },
  });
  ({ summariseTrainingProfile } = await import('../services/assistant/contextService.js'));
});

test('a home trainee is told so, with the no-equipment default', () => {
  const out = summariseTrainingProfile({ currentlyWorksOut: true, trainingLocationPref: 'home' });
  assert.match(out, /Trains at home\./);
  assert.match(out, /no gym equipment/);
});

test('a gym-goer gets no home instruction', () => {
  const out = summariseTrainingProfile({ currentlyWorksOut: true, trainingLocationPref: 'gym' });
  assert.match(out, /Trains at a gym\./);
  assert.doesNotMatch(out, /equipment/);
});

test('"not yet" is an answer, not silence', () => {
  const out = summariseTrainingProfile({ currentlyWorksOut: false, trainingLocationPref: 'gym' });
  assert.match(out, /Not training yet; would rather train at a gym\./);
});

test('frequency, free time and goals are rendered as fixed phrases', () => {
  const out = summariseTrainingProfile({
    currentlyWorksOut: true, trainingLocationPref: 'home', weeklyFrequencyIntent: 'one_two',
    freeTimeWindow: 'evening', fitnessGoals: ['muscle_gain', 'not_a_goal'],
  });
  assert.match(out, /Usually trains 1-2 times a week\./);
  assert.match(out, /Usually free: evenings\./);
  assert.match(out, /Goals: muscle gain\./);
  assert.doesNotMatch(out, /not_a_goal/);
});

test('the "Other" free text never reaches the model', () => {
  const out = summariseTrainingProfile({
    currentlyWorksOut: true, trainingLocationPref: 'other', trainingLocationOther: 'my office in Sector 44',
  });
  assert.doesNotMatch(out, /Sector 44/);
  assert.match(out, /somewhere other than a gym or home/);
});

test('nothing known means no line at all', () => {
  assert.equal(summariseTrainingProfile(null), null);
  assert.equal(summariseTrainingProfile({ currentlyWorksOut: null }), null);
});

test('the same answers always produce the same bytes', () => {
  const profile = { currentlyWorksOut: true, trainingLocationPref: 'home', fitnessGoals: ['weight_loss', 'muscle_gain'] };
  assert.equal(summariseTrainingProfile(profile), summariseTrainingProfile({ ...profile }));
});
