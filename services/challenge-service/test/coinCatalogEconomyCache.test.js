// GET /coins/catalog used to run findMany, THEN an uncached economy-config read,
// then two counts, all in series. Pinned here (caching forced ON):
//  - the economy config used for the catalog DISPLAY is cached 30s, single-flight,
//    failures not cached, and evicted by updateEconomyConfig;
//  - the catalog list and the config read start concurrently;
//  - the uncached loadEconomyConfig (used by reward / redemption paths) always
//    reads fresh;
//  - output is unchanged and a config failure only matters when a gym_trial
//    item needs it.
// Run with: node --experimental-test-module-mocks --test
process.env.CHALLENGE_CACHE_FORCE = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const events = [];
let configReads = 0;
let configRow = null;
let configFail = false;
let items = [];

let mod; let cfg;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.coinEconomyConfig = {
            findUnique: async () => {
              configReads++; events.push('config:start');
              await tick(10);
              events.push('config:end');
              if (configFail) throw new Error('db down');
              return configRow;
            },
            upsert: async ({ update }) => ({ ...update, updatedAt: null }),
          };
          this.coinCatalogItem = {
            count: async () => items.length,
            createMany: async () => {},
            findMany: async () => { events.push('items:start'); await tick(10); events.push('items:end'); return items; },
          };
          this.coinRedemption = { count: async () => 3 };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../utils/analytics.js', import.meta.url).href, { exports: { track: () => {} } });
  t.mock.module(new URL('../services/coinLedgerService.js', import.meta.url).href, {
    exports: { creditCoinsService: async () => {}, debitCoinsService: async () => {}, debitCoinsInTx: async () => {} },
  });
  cfg = await import('../services/coinEconomyConfigService.js');
  mod = await import('../services/coinCatalogService.js');
});

function reset() {
  events.length = 0; configReads = 0; configFail = false; configRow = null; items = [];
}

test('cached display config: second read is served from cache, concurrent reads share one query', async () => {
  reset();
  await Promise.all([cfg.loadEconomyConfigCached(), cfg.loadEconomyConfigCached()]);
  await cfg.loadEconomyConfigCached();
  assert.equal(configReads, 1);
  // evict so later tests start cold
  await cfg.updateEconomyConfig({ coinsPerCheckin: 1, weeklyTargetBonus: 1, milestones: {}, pairedStreakWeeklyBonus: 1, qualifyingCheckinsPerWeek: 2, coinsPerVerifiedWorkout: 1, gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1 }, 1);
});

test('updateEconomyConfig evicts the display cache', async () => {
  reset();
  configRow = { coinsPerCheckin: 1, weeklyTargetBonus: 1, milestones: {}, pairedStreakWeeklyBonus: 1, qualifyingCheckinsPerWeek: 2, coinsPerVerifiedWorkout: 1, gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1, updatedAt: null };
  assert.equal((await cfg.loadEconomyConfigCached()).gymTrialMonthlyCap, 10);
  configRow = { ...configRow, gymTrialMonthlyCap: 4 };
  assert.equal((await cfg.loadEconomyConfigCached()).gymTrialMonthlyCap, 10, 'still cached before the write');
  await cfg.updateEconomyConfig({ coinsPerCheckin: 1, weeklyTargetBonus: 1, milestones: {}, pairedStreakWeeklyBonus: 1, qualifyingCheckinsPerWeek: 2, coinsPerVerifiedWorkout: 1, gymTrialMonthlyCap: 4, gymTrialPerUserLimit: 1 }, 1);
  assert.equal((await cfg.loadEconomyConfigCached()).gymTrialMonthlyCap, 4);
});

test('a failed display read is not cached', async () => {
  reset();
  cfg.loadEconomyConfigCached; // eslint-disable-line no-unused-expressions
  await cfg.updateEconomyConfig({ coinsPerCheckin: 1, weeklyTargetBonus: 1, milestones: {}, pairedStreakWeeklyBonus: 1, qualifyingCheckinsPerWeek: 2, coinsPerVerifiedWorkout: 1, gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1 }, 1);
  configFail = true;
  await assert.rejects(cfg.loadEconomyConfigCached(), /db down/);
  configFail = false;
  assert.equal((await cfg.loadEconomyConfigCached()).gymTrialMonthlyCap, 10);
});

test('the uncached loadEconomyConfig (reward/redemption paths) always hits the DB', async () => {
  reset();
  await cfg.loadEconomyConfig(); await cfg.loadEconomyConfig();
  assert.equal(configReads, 2);
});

test('catalog: the item list and the economy config start concurrently', async () => {
  reset();
  await cfg.updateEconomyConfig({ coinsPerCheckin: 1, weeklyTargetBonus: 1, milestones: {}, pairedStreakWeeklyBonus: 1, qualifyingCheckinsPerWeek: 2, coinsPerVerifiedWorkout: 1, gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1 }, 1);
  configRow = { coinsPerCheckin: 1, weeklyTargetBonus: 1, milestones: {}, pairedStreakWeeklyBonus: 1, qualifyingCheckinsPerWeek: 2, coinsPerVerifiedWorkout: 1, gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1, updatedAt: null };
  items = [{ id: 1, key: 'g', category: 'gym_trial', coinCost: 100, isActive: true }, { id: 2, key: 'b', category: 'buddy_unlock', coinCost: 50, isActive: true }];
  const out = await mod.listActiveCatalogService(9);
  assert.deepEqual(events.slice(0, 2).sort(), ['config:start', 'items:start']);
  assert.deepEqual(out.find((i) => i.key === 'g'), { id: 1, key: 'g', category: 'gym_trial', coinCost: 100, isActive: true, unitsRemainingThisMonth: 7, alreadyClaimedByUser: true });
  assert.deepEqual(out.find((i) => i.key === 'b'), { id: 2, key: 'b', category: 'buddy_unlock', coinCost: 50, isActive: true });
});

test('catalog: a config failure does not break a catalog with no gym_trial item', async () => {
  reset();
  await cfg.updateEconomyConfig({ coinsPerCheckin: 1, weeklyTargetBonus: 1, milestones: {}, pairedStreakWeeklyBonus: 1, qualifyingCheckinsPerWeek: 2, coinsPerVerifiedWorkout: 1, gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1 }, 1);
  configFail = true;
  items = [{ id: 2, key: 'b', category: 'buddy_unlock', coinCost: 50, isActive: true }];
  const out = await mod.listActiveCatalogService(9);
  assert.equal(out.length, 1);
  // ...but it still surfaces when a gym_trial item needs it
  items = [{ id: 1, key: 'g', category: 'gym_trial', coinCost: 100, isActive: true }];
  await assert.rejects(mod.listActiveCatalogService(9), /db down/);
});
