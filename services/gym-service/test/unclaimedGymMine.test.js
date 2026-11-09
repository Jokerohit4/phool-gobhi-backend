// GET /unclaimed/:id — the customer-facing read of a saved non-partner gym
// (services/unclaimedGymService.js getMyUnclaimedGymService).
//
// The app uses it to show "check in" only when the person is near the gym, so
// it needs the coordinates. The rule worth pinning is who may read them: a gym
// pinned by hand carries the pinner's own location, so only the pinner may read
// it, and everyone else must get the same 404 as a missing id.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let getMyUnclaimedGymService;
const rows = new Map();

test('setup: stub Prisma and import the service', async (t) => {
  t.mock.module('@prisma/client', {
    namedExports: {
      PrismaClient: class {
        constructor() {
          this.unclaimedGym = {
            findUnique: async ({ where }) => rows.get(where.id) ?? null,
          };
        }
      },
    },
  });
  ({ getMyUnclaimedGymService } = await import('../services/unclaimedGymService.js'));
});

function row(over = {}) {
  return {
    id: 5,
    googlePlaceId: 'ChIJabc',
    name: 'Iron Works',
    address: '12 MG Road',
    city: 'Gurugram',
    lat: 28.4595,
    lng: 77.0266,
    addedByUserId: 99,
    claimStatus: 'unclaimed',
    claimedGymId: null,
    ...over,
  };
}

test('a Google Places gym is readable by any signed-in user', async () => {
  rows.set(5, row());
  const gym = await getMyUnclaimedGymService(5, 1);
  assert.equal(gym.name, 'Iron Works');
  assert.equal(gym.lat, 28.4595);
  assert.equal(gym.lng, 77.0266);
});

test('only what the app needs is returned: no Places id, no who-added-it', async () => {
  rows.set(5, row());
  const gym = await getMyUnclaimedGymService(5, 1);
  assert.deepEqual(Object.keys(gym).sort(), [
    'address',
    'city',
    'claimStatus',
    'claimedGymId',
    'id',
    'lat',
    'lng',
    'name',
  ]);
});

test('a hand-pinned gym is readable by the person who pinned it', async () => {
  rows.set(6, row({ id: 6, googlePlaceId: 'manual:abc', addedByUserId: 42 }));
  const gym = await getMyUnclaimedGymService(6, 42);
  assert.equal(gym.id, 6);
  // The user id can arrive as a header string.
  assert.equal((await getMyUnclaimedGymService(6, '42')).id, 6);
});

test('a hand-pinned gym is a 404 for anyone else, same as a missing id', async () => {
  rows.set(6, row({ id: 6, googlePlaceId: 'manual:abc', addedByUserId: 42 }));
  await assert.rejects(getMyUnclaimedGymService(6, 7), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  await assert.rejects(getMyUnclaimedGymService(404, 7), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
});
