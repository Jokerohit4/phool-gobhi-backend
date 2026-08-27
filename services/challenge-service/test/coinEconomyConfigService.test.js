// Covers QA test plan section A (streak-threshold config validation) plus
// the pre-existing coin-amount validation. Run with:
//   node --experimental-test-module-mocks --test
//
// The module is imported ONCE for the whole file (not re-imported with a
// cache-busting query string per test) — @prisma/client is mocked with a
// single mutable stand-in whose behavior each test reconfigures before
// calling the SUT. Re-importing the module fresh per test (via `?t=...`)
// works for correctness but confuses --experimental-test-coverage's
// aggregation across the file (it ends up reporting only the LAST-loaded
// instance's hits) — this shape gives accurate coverage AND correctness.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const prismaMock = {
  findUnique: async () => { throw new Error('coinEconomyConfig.findUnique not configured for this test'); },
  upsert: async () => { throw new Error('coinEconomyConfig.upsert not configured for this test'); },
};

let updateEconomyConfig;
let loadEconomyConfig;

test('setup: mock @prisma/client once, import the real module once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.coinEconomyConfig = {
            findUnique: (...args) => prismaMock.findUnique(...args),
            upsert: (...args) => prismaMock.upsert(...args),
          };
        }
      },
    },
  });
  ({ updateEconomyConfig, loadEconomyConfig } = await import('../services/coinEconomyConfigService.js'));
  assert.equal(typeof updateEconomyConfig, 'function');
});

const VALID_BASE = {
  coinsPerCheckin: 10,
  weeklyTargetBonus: 20,
  milestones: { '2': 50, '4': 150, '12': 500 },
  pairedStreakWeeklyBonus: 15,
};

test('rejects qualifyingCheckinsPerWeek = 0 (below min)', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 0 }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /qualifyingCheckinsPerWeek must be a whole number between 1 and 7/);
      return true;
    }
  );
});

test('rejects qualifyingCheckinsPerWeek = 8 (above max)', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 8 }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /must be a whole number between 1 and 7/);
      return true;
    }
  );
});

test('rejects a non-integer qualifyingCheckinsPerWeek', async () => {
  await assert.rejects(() => updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 2.5 }));
  await assert.rejects(() => updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 'abc' }));
});

test('rejects a negative coinsPerCheckin before qualifyingCheckinsPerWeek is even checked', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, coinsPerCheckin: -5, qualifyingCheckinsPerWeek: 999 }),
    (err) => {
      assert.match(err.error, /coinsPerCheckin must be a whole number between 0 and 100000/);
      return true;
    }
  );
});

test('rejects coinsPerCheckin above MAX_COIN_AMOUNT', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, coinsPerCheckin: 100_001, qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /coinsPerCheckin must be a whole number between 0 and 100000/);
      return true;
    }
  );
});

test('rejects a non-integer coinsPerCheckin (validateAmount non-integer branch)', async () => {
  await assert.rejects(() => updateEconomyConfig({ ...VALID_BASE, coinsPerCheckin: 1.5, qualifyingCheckinsPerWeek: 2 }));
});

test('rejects a negative weeklyTargetBonus and a negative pairedStreakWeeklyBonus', async () => {
  await assert.rejects(() => updateEconomyConfig({ ...VALID_BASE, weeklyTargetBonus: -1, qualifyingCheckinsPerWeek: 2 }));
  await assert.rejects(() => updateEconomyConfig({ ...VALID_BASE, pairedStreakWeeklyBonus: -1, qualifyingCheckinsPerWeek: 2 }));
});

test('rejects milestones that is an array instead of an object', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, milestones: [50, 150], qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /milestones must be an object/);
      return true;
    }
  );
});

test('rejects milestones that is null', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, milestones: null, qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /milestones must be an object/);
      return true;
    }
  );
});

test('rejects a milestone with a non-positive week key', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, milestones: { '0': 50 }, qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /milestone key "0" must be a positive whole number of weeks/);
      return true;
    }
  );
});

test('rejects a milestone with a non-integer week key', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, milestones: { '1.5': 50 }, qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /milestone key "1.5" must be a positive whole number of weeks/);
      return true;
    }
  );
});

test('rejects a milestone whose coin amount is invalid', async () => {
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, milestones: { '2': -10 }, qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /milestone amount for week 2 must be a whole number/);
      return true;
    }
  );
});

// loadEconomyConfig — no row yet (fresh DB) falls back to DEFAULT_ECONOMY_CONFIG.
test('loadEconomyConfig returns defaults (incl. qualifyingCheckinsPerWeek: 2) when no row exists', async () => {
  prismaMock.findUnique = async () => null;
  const config = await loadEconomyConfig();
  assert.equal(config.qualifyingCheckinsPerWeek, 2);
  assert.equal(config.coinsPerCheckin, 10);
  assert.equal(config.updatedAt, null);
});

// loadEconomyConfig — a real row overrides the defaults.
test('loadEconomyConfig returns the stored row when one exists', async () => {
  prismaMock.findUnique = async () => ({
    id: 1, coinsPerCheckin: 25, weeklyTargetBonus: 40, milestones: { '3': 99 },
    pairedStreakWeeklyBonus: 5, qualifyingCheckinsPerWeek: 5, updatedAt: new Date('2026-08-27T00:00:00Z'),
  });
  const config = await loadEconomyConfig();
  assert.equal(config.qualifyingCheckinsPerWeek, 5);
  assert.equal(config.coinsPerCheckin, 25);
  assert.deepEqual(config.milestones, { '3': 99 });
});

// Happy path — the mocked upsert actually "succeeds" and we assert on
// exactly what gets persisted and returned, including the accepted
// boundary values 1 and 7 for qualifyingCheckinsPerWeek.
test('valid update persists qualifyingCheckinsPerWeek and returns it', async () => {
  let upsertArgs = null;
  prismaMock.upsert = async (args) => {
    upsertArgs = args;
    return { ...args.create, updatedAt: new Date('2026-08-27T00:00:00Z') };
  };

  const result = await updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 4 }, 99);

  assert.equal(result.qualifyingCheckinsPerWeek, 4);
  assert.equal(upsertArgs.create.qualifyingCheckinsPerWeek, 4);
  assert.equal(upsertArgs.update.qualifyingCheckinsPerWeek, 4);
  assert.equal(upsertArgs.create.updatedBy, 99);
  assert.deepEqual(upsertArgs.create.milestones, { '2': 50, '4': 150, '12': 500 });
});

test('accepts the boundary values 1 and 7 for qualifyingCheckinsPerWeek', async () => {
  prismaMock.upsert = async (args) => ({ ...args.create, updatedAt: new Date() });
  const low = await updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 1 });
  const high = await updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 7 });
  assert.equal(low.qualifyingCheckinsPerWeek, 1);
  assert.equal(high.qualifyingCheckinsPerWeek, 7);
});

test('a milestone whose week key has redundant formatting (e.g. "02") is normalized', async () => {
  let upsertArgs = null;
  prismaMock.upsert = async (args) => { upsertArgs = args; return { ...args.create, updatedAt: new Date() }; };
  await updateEconomyConfig({ ...VALID_BASE, milestones: { '02': 50 }, qualifyingCheckinsPerWeek: 2 });
  assert.deepEqual(upsertArgs.create.milestones, { '2': 50 });
});
