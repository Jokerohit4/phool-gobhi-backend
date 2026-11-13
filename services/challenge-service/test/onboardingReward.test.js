// The onboarding reward ladder: the server owns the amounts and pays each
// step once per user.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const credits = [];
let claimOnboardingRewardService;
let ONBOARDING_COIN_REWARDS;

test('setup: mock the coin ledger, import the service', async (t) => {
  t.mock.module(new URL('../services/coinLedgerService.js', import.meta.url).href, {
    exports: {
      creditCoinsService: async (...args) => { credits.push(args); return { balance: 10 }; },
    },
  });
  ({ claimOnboardingRewardService, ONBOARDING_COIN_REWARDS } = await import('../services/onboardingRewardService.js'));
});

test('pays the server-defined amount, keyed per user and step', async () => {
  credits.length = 0;
  const result = await claimOnboardingRewardService(7, 'details');
  assert.equal(result.amount, 10);
  assert.deepEqual(credits[0], [7, 10, 'Onboarding reward: details', 'onboarding:7:details']);
});

test('the ladder totals 20 coins', () => {
  assert.equal(Object.values(ONBOARDING_COIN_REWARDS).reduce((a, b) => a + b, 0), 20);
});

test('an unknown step is refused and pays nothing', async () => {
  credits.length = 0;
  await assert.rejects(() => claimOnboardingRewardService(7, 'anything'), (e) => e.status === 400);
  assert.equal(credits.length, 0);
});
