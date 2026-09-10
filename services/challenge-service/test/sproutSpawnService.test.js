// Covers the Wave 2 wild-Sprout spawn/catch flow (see
// sprint2/explore-map-wave2-pokemongo-redesign-spec.html §12-13): seed-on-read
// spawn generation anchored to a challenge's checkpoints, and a
// server-authoritative catch that re-validates proximity/expiry/not-already-
// caught before paying real coins. Run with:
//   node --experimental-test-module-mocks --test
//
// Single import of the SUT for the whole file (see streakService.test.js's
// header comment for why). Both of sproutSpawnService's dependencies
// (@prisma/client, coinLedgerService) are mocked once with mutable state each
// test resets/reconfigures.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = { challenges: new Map(), spawns: new Map() };
let nextId = 1;
let creditCalls = [];

function resetFakes() {
  db.challenges.clear();
  db.spawns.clear();
  nextId = 1;
  creditCalls = [];
}

function seedChallenge(id, checkpointSpots) {
  db.challenges.set(id, { id, checkpointSpots });
}

let getNearbySproutsService, catchSproutService;

test('setup: mock dependencies once, import the real module once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.challenge = {
            findUnique: async ({ where: { id } }) => db.challenges.get(id) ?? null,
          };
          this.sproutSpawn = {
            findMany: async ({ where }) =>
              [...db.spawns.values()].filter(
                (s) => s.challengeId === where.challengeId
                  && s.expiresAt.getTime() > where.expiresAt.gt.getTime()
                  && s.caughtByUserId === null,
              ),
            findUnique: async ({ where: { id } }) => db.spawns.get(id) ?? null,
            create: async ({ data }) => {
              const row = { id: nextId++, caughtByUserId: null, caughtAt: null, ...data };
              db.spawns.set(row.id, row);
              return row;
            },
            updateMany: async ({ where, data }) => {
              const row = db.spawns.get(where.id);
              if (!row || row.caughtByUserId !== where.caughtByUserId) return { count: 0 };
              Object.assign(row, data);
              return { count: 1 };
            },
          };
        }
      },
    },
  });
  t.mock.module(new URL('../services/coinLedgerService.js', import.meta.url).href, {
    exports: {
      creditCoinsService: async (userId, amount, description, idempotencyKey) => {
        creditCalls.push({ userId, amount, description, idempotencyKey });
        return { userId, balance: amount };
      },
    },
  });

  ({ getNearbySproutsService, catchSproutService } =
    await import('../services/sproutSpawnService.js'));
  assert.equal(typeof getNearbySproutsService, 'function');
});

test('getNearbySproutsService seeds spawns anchored to the challenge\'s checkpoints when none exist', async () => {
  resetFakes();
  seedChallenge(1, [{ lat: 28.45, lng: 77.02 }, { lat: 28.46, lng: 77.03 }]);

  const spawns = await getNearbySproutsService(1, {});

  assert.ok(spawns.length >= 2 && spawns.length <= 3, 'seeds 2-3 spawns per the spec');
  for (const s of spawns) {
    assert.ok(['floret_pup', 'iron_floret', 'cardio_sprig', 'zen_stalk'].includes(s.speciesKey));
    assert.ok(s.speciesName, 'serialized shape includes a display name');
    assert.ok(s.expiresAt instanceof Date);
  }
});

test('getNearbySproutsService does not reseed once at the live-spawn floor', async () => {
  resetFakes();
  seedChallenge(2, [{ lat: 28.45, lng: 77.02 }]);
  const first = await getNearbySproutsService(2, {});
  const createCallsAfterFirst = db.spawns.size;

  const second = await getNearbySproutsService(2, {});

  assert.equal(db.spawns.size, createCallsAfterFirst, 'no new spawns created once the floor is met');
  assert.equal(second.length, first.length);
});

test('getNearbySproutsService anchors to the caller\'s own position for a gym-native challenge (no checkpoints)', async () => {
  resetFakes();
  seedChallenge(3, []);

  const spawns = await getNearbySproutsService(3, { lat: 12.9, lng: 77.6 });

  assert.ok(spawns.length > 0, 'falls back to the caller position as the sole anchor');
});

test('catchSproutService pays coins and marks the spawn caught on a successful nearby catch', async () => {
  resetFakes();
  db.spawns.set(1, {
    id: 1, challengeId: 5, speciesKey: 'iron_floret', rarity: 'uncommon', coinValue: 15,
    lat: 28.45, lng: 77.02, expiresAt: new Date(Date.now() + 60_000),
    caughtByUserId: null, caughtAt: null,
  });

  const result = await catchSproutService(42, 5, 1, { lat: 28.45001, lng: 77.02001 });

  assert.equal(result.caught, true);
  assert.equal(result.coinsAwarded, 15);
  assert.equal(creditCalls.length, 1);
  assert.equal(creditCalls[0].userId, 42);
  assert.equal(creditCalls[0].idempotencyKey, 'sprout-catch:1');
  assert.equal(db.spawns.get(1).caughtByUserId, 42);
});

test('catchSproutService rejects a catch attempt too far from the spawn', async () => {
  resetFakes();
  db.spawns.set(2, {
    id: 2, challengeId: 5, speciesKey: 'floret_pup', rarity: 'common', coinValue: 5,
    lat: 28.45, lng: 77.02, expiresAt: new Date(Date.now() + 60_000),
    caughtByUserId: null, caughtAt: null,
  });

  await assert.rejects(
    () => catchSproutService(42, 5, 2, { lat: 29.0, lng: 78.0 }),
    (err) => err.code === 'TOO_FAR' && err.status === 400,
  );
  assert.equal(creditCalls.length, 0, 'no payout for a rejected catch');
});

test('catchSproutService returns caught:false for an already-caught spawn without double-paying', async () => {
  resetFakes();
  db.spawns.set(3, {
    id: 3, challengeId: 5, speciesKey: 'zen_stalk', rarity: 'rare', coinValue: 40,
    lat: 28.45, lng: 77.02, expiresAt: new Date(Date.now() + 60_000),
    caughtByUserId: 7, caughtAt: new Date(),
  });

  const result = await catchSproutService(42, 5, 3, { lat: 28.45, lng: 77.02 });

  assert.equal(result.caught, false);
  assert.equal(creditCalls.length, 0);
});

test('catchSproutService returns caught:false for an expired spawn', async () => {
  resetFakes();
  db.spawns.set(4, {
    id: 4, challengeId: 5, speciesKey: 'floret_pup', rarity: 'common', coinValue: 5,
    lat: 28.45, lng: 77.02, expiresAt: new Date(Date.now() - 60_000),
    caughtByUserId: null, caughtAt: null,
  });

  const result = await catchSproutService(42, 5, 4, { lat: 28.45, lng: 77.02 });

  assert.equal(result.caught, false);
  assert.equal(creditCalls.length, 0);
});
