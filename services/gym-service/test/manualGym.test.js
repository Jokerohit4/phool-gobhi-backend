// "Can't find your gym? Add it" (services/unclaimedGymService.js
// addManualGymService). Prisma is mocked: these pin validation, the partner
// match running first, de-duplication of the user's own pins, and the
// `manual:` marker that downstream grading relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let svc;
const db = { partners: [], mine: [], created: [] };

test('setup: stub Prisma and import the service', async (t) => {
  t.mock.module('@prisma/client', {
    namedExports: {
      PrismaClient: class {
        constructor() {
          this.gym = { findMany: async () => db.partners };
          this.unclaimedGym = {
            findMany: async () => db.mine,
            create: async ({ data }) => {
              const row = { id: 100 + db.created.length, ...data };
              db.created.push(row);
              return row;
            },
          };
        }
      },
    },
  });
  svc = await import('../services/unclaimedGymService.js');
});

const AT = { lat: 28.4595, lng: 77.0266 };
function reset() {
  db.partners = [];
  db.mine = [];
  db.created = [];
}

test('creates a manual gym pinned at the phone, marked with the manual: prefix', async () => {
  reset();
  const out = await svc.addManualGymService({ name: '  Sharma   Fitness  ', ...AT }, 7);
  assert.equal(out.matchedGymId, null);
  assert.equal(out.unclaimedGym.name, 'Sharma Fitness');
  assert.equal(out.unclaimedGym.addedByUserId, 7);
  assert.equal(out.unclaimedGym.lat, AT.lat);
  assert.ok(svc.isManualPlaceId(out.unclaimedGym.googlePlaceId));
  assert.equal(db.created.length, 1);
});

test('a partner gym at the same spot wins over a manual row', async () => {
  reset();
  db.partners = [{ id: 3, name: 'Iron House', lat: AT.lat, lng: AT.lng }];
  const out = await svc.addManualGymService({ name: 'Iron House Gym', ...AT }, 7);
  assert.equal(out.matchedGymId, 3);
  assert.equal(out.unclaimedGym, null);
  assert.equal(db.created.length, 0);
});

test("re-adding the user's own nearby pin of the same name reuses it", async () => {
  reset();
  db.mine = [{ id: 55, googlePlaceId: 'manual:abc', name: 'Sharma Fitness', lat: AT.lat, lng: AT.lng, addedByUserId: 7 }];
  const out = await svc.addManualGymService({ name: 'sharma fitness', lat: AT.lat + 0.0003, lng: AT.lng }, 7);
  assert.equal(out.unclaimedGym.id, 55);
  assert.equal(db.created.length, 0);
});

test('validation: name length, missing location, outside India', async () => {
  reset();
  await assert.rejects(svc.addManualGymService({ name: 'x', ...AT }, 7), (e) => e.status === 400);
  await assert.rejects(svc.addManualGymService({ name: 'a'.repeat(81), ...AT }, 7), (e) => e.status === 400);
  await assert.rejects(svc.addManualGymService({ name: 'Gym', lat: NaN, lng: 77 }, 7), (e) => e.status === 400);
  await assert.rejects(svc.addManualGymService({ name: 'Gym', lat: 51.5, lng: -0.12 }, 7), (e) => e.status === 422);
  assert.equal(db.created.length, 0);
});

test('isManualPlaceId only matches the prefix', () => {
  assert.equal(svc.isManualPlaceId('manual:123'), true);
  assert.equal(svc.isManualPlaceId('ChIJxyz'), false);
  assert.equal(svc.isManualPlaceId(null), false);
});
