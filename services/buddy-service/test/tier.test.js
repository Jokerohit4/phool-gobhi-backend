// Buddy discovery tier gating (utils/tier.js) — the premium-gating hook for
// so-far-unlocked discovery filters. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let isTierAtLeast, FILTER_SPECS, assertTierAllows;

test('setup: import tier', async () => {
  ({ isTierAtLeast, FILTER_SPECS, assertTierAllows } = await import('../utils/tier.js'));
});

test('isTierAtLeast: null minimum is always satisfied', () => {
  assert.equal(isTierAtLeast('general', null), true);
  assert.equal(isTierAtLeast(undefined, null), true);
  assert.equal(isTierAtLeast('premium', null), true);
});

test('isTierAtLeast: tier order general < sub_premium < premium', () => {
  assert.equal(isTierAtLeast('premium', 'premium'), true);
  assert.equal(isTierAtLeast('premium', 'sub_premium'), true);
  assert.equal(isTierAtLeast('premium', 'general'), true);
  assert.equal(isTierAtLeast('sub_premium', 'sub_premium'), true);
  assert.equal(isTierAtLeast('sub_premium', 'premium'), false);
  assert.equal(isTierAtLeast('general', 'premium'), false);
  assert.equal(isTierAtLeast('general', 'sub_premium'), false);
});

test('isTierAtLeast: an unknown minimum tier fails open (treated as no gate)', () => {
  assert.equal(isTierAtLeast('general', 'platinum'), true);
  assert.equal(isTierAtLeast(undefined, 'platinum'), true);
});

test('isTierAtLeast: an unknown user tier is treated as weaker than any known minimum', () => {
  assert.equal(isTierAtLeast('trial', 'general'), false);
  assert.equal(isTierAtLeast(null, 'general'), false);
});

test('FILTER_SPECS: every current discovery filter is unlocked (minTier null)', () => {
  assert.deepEqual(FILTER_SPECS, {
    radiusKm: { minTier: null },
    genders: { minTier: null },
    fitnessGoals: { minTier: null },
    ageRange: { minTier: null },
  });
  for (const spec of Object.values(FILTER_SPECS)) assert.equal(spec.minTier, null);
});

test('assertTierAllows: never throws while every filter is unlocked', () => {
  for (const key of Object.keys(FILTER_SPECS)) {
    assertTierAllows('general', key); // must not throw
  }
});

test('assertTierAllows: unknown filter keys pass through', () => {
  assertTierAllows('general', 'does-not-exist');
});

test('assertTierAllows: enforces a minTier when a filter is gated', () => {
  // Simulate flipping one filter premium-only by temporarily overriding the spec.
  const original = FILTER_SPECS.fitnessGoals.minTier;
  FILTER_SPECS.fitnessGoals.minTier = 'premium';
  try {
    assertTierAllows('general', 'fitnessGoals'); // should throw
    assert.fail('expected premium gate to reject a general user');
  } catch (err) {
    assert.equal(err.status, 403);
    assert.match(err.error, /premium/);
  }
  assertTierAllows('premium', 'fitnessGoals'); // premium passes
  FILTER_SPECS.fitnessGoals.minTier = original;
});