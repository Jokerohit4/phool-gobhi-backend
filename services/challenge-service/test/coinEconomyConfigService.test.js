// Covers QA test plan section A (streak-threshold config validation) plus
// the pre-existing coin-amount validation. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const VALID_BASE = {
  coinsPerCheckin: 10,
  weeklyTargetBonus: 20,
  milestones: { '2': 50, '4': 150, '12': 500 },
  pairedStreakWeeklyBonus: 15,
};

// updateEconomyConfig validates every field before it ever touches prisma,
// so these run with zero mocking — a real (uninitialized) PrismaClient
// import is fine since the invalid-input paths throw first.
test('rejects qualifyingCheckinsPerWeek = 0 (below min)', async () => {
  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js');
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
  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js');
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
  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js');
  await assert.rejects(() => updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 2.5 }));
  await assert.rejects(() => updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 'abc' }));
});

test('accepts the full valid range 1..7 for qualifyingCheckinsPerWeek (validation only)', async () => {
  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js');
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    // These will still throw once they reach the prisma call (no live DB
    // here) — we only care that they get PAST validation, i.e. the error
    // is not the qualifyingCheckinsPerWeek 400.
    await assert.rejects(
      () => updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: n }),
      (err) => {
        assert.ok(!/qualifyingCheckinsPerWeek/.test(String(err.error ?? err.message ?? '')));
        return true;
      }
    );
  }
});

test('rejects a negative coinsPerCheckin before qualifyingCheckinsPerWeek is even checked', async () => {
  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js');
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, coinsPerCheckin: -5, qualifyingCheckinsPerWeek: 999 }),
    (err) => {
      assert.match(err.error, /coinsPerCheckin must be a whole number between 0 and 100000/);
      return true;
    }
  );
});

test('rejects a milestone with a non-positive week key', async () => {
  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js');
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, milestones: { '0': 50 }, qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /milestone key "0" must be a positive whole number of weeks/);
      return true;
    }
  );
});

test('rejects milestones that is an array instead of an object', async () => {
  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js');
  await assert.rejects(
    () => updateEconomyConfig({ ...VALID_BASE, milestones: [50, 150], qualifyingCheckinsPerWeek: 2 }),
    (err) => {
      assert.match(err.error, /milestones must be an object/);
      return true;
    }
  );
});

// Happy path — mock @prisma/client so the upsert actually "succeeds" and we
// can assert on exactly what gets persisted and returned.
test('valid update persists qualifyingCheckinsPerWeek and returns it', async (t) => {
  let upsertArgs = null;
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.coinEconomyConfig = {
            upsert: async (args) => {
              upsertArgs = args;
              return { ...args.create, updatedAt: new Date('2026-08-27T00:00:00Z') };
            },
          };
        }
      },
    },
  });

  const { updateEconomyConfig } = await import('../services/coinEconomyConfigService.js?t=happy-path');
  const result = await updateEconomyConfig({ ...VALID_BASE, qualifyingCheckinsPerWeek: 4 }, 99);

  assert.equal(result.qualifyingCheckinsPerWeek, 4);
  assert.equal(upsertArgs.create.qualifyingCheckinsPerWeek, 4);
  assert.equal(upsertArgs.update.qualifyingCheckinsPerWeek, 4);
  assert.equal(upsertArgs.create.updatedBy, 99);
});
