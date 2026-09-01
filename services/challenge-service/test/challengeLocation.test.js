// Covers the location-based challenge rules (20km radius): list filtering
// (only challenges within MAX_CHALLENGE_DISTANCE_KM of the user are shown —
// and nothing at all when no location headers are sent), detail/page 404 for
// out-of-range challenges, and enrollment rejecting anything beyond 20km or
// without a user location. Run with:
//   node --experimental-test-module-mocks --test
//
// Same conventions as the sibling test files: @prisma/client is mocked once
// with a mutable in-memory stand-in, and the real service modules are
// imported once. utils/location.js (pure math + the 20km constant) is left
// REAL so the tests exercise the actual enforcement logic, not a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CHALLENGE_DEFINITION_OFF_PEAK = {
  key: 'off_peak_hunter_v1', type: 'off_peak_hunter', category: 'gym_native',
  title: 'Off-Peak Hunter', description: 'Check in during off-peak hours 5 times to earn coins.',
  defaultVerificationMethod: 'booking_attendance',
};
const CHALLENGE_DEFINITION_QUEST = {
  key: 'city_explorer_quest_v1', type: 'poi_checkin_tour', category: 'outside_gym_city',
  title: 'Gurugram Explorer Quest', description: 'Visit every checkpoint sticker.',
  defaultVerificationMethod: 'qr_scan',
};

const GORAKHPUR = { lat: 26.7596, lng: 83.3727 };
const GURUGRAM = { lat: 28.4766, lng: 77.0841 };
// ~1100km north of Gorakhpur — unambiguously outside any 20km radius.
const FAR_AWAY = { lat: 30.3165, lng: 78.0322 };
// The services read user location as userLat/userLng (from the gateway's
// x-user-lat/x-user-lng headers), separate from a challenge's lat/lng anchor.
const USER_GORAKHPUR = { userLat: GORAKHPUR.lat, userLng: GORAKHPUR.lng };
const NO_LOCATION = { userLat: null, userLng: null };

const db = {
  challenges: new Map(),
  definitions: new Map([
    [1, { id: 1, ...CHALLENGE_DEFINITION_OFF_PEAK }],
    [2, { id: 2, ...CHALLENGE_DEFINITION_QUEST }],
  ]),
  enrollments: new Map(),
  // The seed's find-first lookup for (definitionId, city) — returns an
  // already-anchored row so ensureSeeded backfills nothing and creates
  // nothing, keeping db.listReturn the only thing listActiveChallengesService
  // ever sees.
  seedLookup: new Map(
    ['1|Gurugram', '1|Gorakhpur', '2|Gurugram', '2|Gorakhpur'].map((k) => [k, { id: 900, lat: 28, lng: 77 }])
  ),
  listReturn: [],
};
let nextId = 1;

function resetFakes() {
  db.challenges.clear();
  db.enrollments.clear();
  db.listReturn = [];
}

function challengeRow(id, definitionId, { city, lat, lng, targetCount = 5, rewardCoins = 150 }) {
  return {
    id,
    challengeDefinitionId: definitionId,
    challengeDefinition: definitionId === 1 ? CHALLENGE_DEFINITION_OFF_PEAK : CHALLENGE_DEFINITION_QUEST,
    city, status: 'active', targetCount, rewardCoins,
    offPeakWindows: definitionId === 1 ? [{ startHourIst: 6, endHourIst: 9 }] : null,
    lat, lng, enrollments: [], checkpointSpots: [],
  };
}

let listActiveChallengesService;
let getChallengeDetailService;
let enrollService;

test('setup: mock @prisma/client once, import the real services once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.challengeDefinition = {
            findUnique: async ({ where: { key } }) =>
              [...db.definitions.values()].find((d) => d.key === key) ?? null,
            create: async ({ data }) => {
              const row = { id: nextId++, ...data };
              db.definitions.set(row.id, row);
              return row;
            },
          };
          this.challenge = {
            findUnique: async ({ where: { id } }) => db.challenges.get(id) ?? null,
            findFirst: async ({ where }) =>
              db.seedLookup.get(`${where.challengeDefinitionId}|${where.city}`) ?? null,
            findMany: async () => db.listReturn,
            create: async ({ data }) => {
              const row = { id: nextId++, status: 'active', ...data, enrollments: [], checkpointSpots: [] };
              db.challenges.set(row.id, row);
              return row;
            },
            update: async ({ where: { id }, data }) => {
              const row = db.challenges.get(id);
              if (row) Object.assign(row, data);
              return row;
            },
          };
          this.challengeCheckpointSpot = {
            count: async () => 999,
            createMany: async () => ({ count: 0 }),
          };
          this.challengeCheckpointVisit = {
            findMany: async () => [],
          };
          this.challengeEnrollment = {
            findUnique: async ({ where: { userId_challengeId } }) =>
              db.enrollments.get(`${userId_challengeId.userId}|${userId_challengeId.challengeId}`) ?? null,
            create: async ({ data }) => {
              const row = {
                id: nextId++, status: 'active', progressCount: 0, startedAt: new Date(), completedAt: null, ...data,
              };
              db.enrollments.set(`${data.userId}|${data.challengeId}`, row);
              return row;
            },
          };
        }
      },
    },
  });

  ({ listActiveChallengesService, getChallengeDetailService } = await import('../services/challengeCatalogService.js'));
  ({ enrollService } = await import('../services/challengeEnrollmentService.js'));
  assert.equal(typeof listActiveChallengesService, 'function');
  assert.equal(typeof enrollService, 'function');
});

// ---- listActiveChallengesService --------------------------------------

test('list shows only challenges within 20km, nearest first, with distanceKm', async () => {
  resetFakes();
  db.listReturn = [
    challengeRow(11, 1, { city: 'Gurugram', ...GURUGRAM }),
    challengeRow(12, 1, { city: 'Gorakhpur', ...GORAKHPUR }),
    challengeRow(13, 2, { city: 'Gorakhpur', ...GORAKHPUR, rewardCoins: 200 }),
    challengeRow(14, 2, { city: 'Dehradun', ...FAR_AWAY }),
    challengeRow(15, 1, { city: 'Unknown', lat: null, lng: null }),
  ];

  const result = await listActiveChallengesService({ userId: 1, ...USER_GORAKHPUR });

  assert.deepEqual(result.map((c) => c.id), [12, 13], 'only the two Gorakhpur challenges are within 20km');
  assert.ok(result.every((c) => c.distanceKm != null && c.distanceKm <= 20));
  assert.ok(result[0].distanceKm <= result[1].distanceKm, 'sorted nearest first');
  assert.equal(result[0].lat, GORAKHPUR.lat);
  assert.equal(result[1].city, 'Gorakhpur');
});

test('list returns [] when the caller sends no location headers', async () => {
  resetFakes();
  db.listReturn = [
    challengeRow(21, 1, { ...GORAKHPUR }),
    challengeRow(22, 2, { city: 'Gurugram', lat: GURUGRAM.lat, lng: GURUGRAM.lng }),
  ];

  const result = await listActiveChallengesService({ userId: 1, ...NO_LOCATION });

  assert.deepEqual(result, [], 'no location → nothing can be proven within range');
});

// ---- getChallengeDetailService ----------------------------------------

test('detail returns the challenge for a user within 20km', async () => {
  resetFakes();
  db.challenges.set(31, challengeRow(31, 2, { city: 'Gorakhpur', ...GORAKHPUR, rewardCoins: 200 }));

  const result = await getChallengeDetailService(31, { userId: 1, ...USER_GORAKHPUR });

  assert.equal(result.id, 31);
  assert.equal(result.city, 'Gorakhpur');
  assert.deepEqual(result.myVisitedSpotIds, []);
});

test('detail 404s for a challenge beyond 20km (and for one with no anchor)', async () => {
  resetFakes();
  db.challenges.set(32, challengeRow(32, 2, { city: 'Gurugram', ...GURUGRAM }));
  db.challenges.set(33, challengeRow(33, 1, { city: 'Unknown', lat: null, lng: null }));

  await assert.rejects(
    () => getChallengeDetailService(32, { userId: 1, ...USER_GORAKHPUR }),
    (err) => {
      assert.equal(err.status, 404);
      assert.match(err.error, /not found/);
      return true;
    }
  );
  await assert.rejects(
    () => getChallengeDetailService(33, { userId: 1, ...USER_GORAKHPUR }),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

// ---- enrollService (challengeEnrollmentService) ------------------------

test('enroll succeeds for a challenge within 20km of the user', async () => {
  resetFakes();
  db.challenges.set(41, challengeRow(41, 1, { city: 'Gorakhpur', ...GORAKHPUR }));

  const result = await enrollService(7, 41, USER_GORAKHPUR);

  assert.equal(result.status, 'active');
  assert.equal(db.enrollments.get('7|41').challengeId, 41);
});

test('enroll rejects a challenge beyond 20km', async () => {
  resetFakes();
  db.challenges.set(42, challengeRow(42, 1, { city: 'Gurugram', ...GURUGRAM }));

  await assert.rejects(
    () => enrollService(7, 42, USER_GORAKHPUR),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.error, /20km/);
      return true;
    }
  );
});

test('enroll rejects when no location is provided (fails closed)', async () => {
  resetFakes();
  db.challenges.set(43, challengeRow(43, 1, { city: 'Gorakhpur', ...GORAKHPUR }));

  await assert.rejects(
    () => enrollService(7, 43, NO_LOCATION),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /Location is required/);
      return true;
    }
  );
});

test('enroll rejects a challenge with no anchor even when the user has a location', async () => {
  resetFakes();
  db.challenges.set(44, challengeRow(44, 1, { city: 'Unknown', lat: null, lng: null }));

  await assert.rejects(
    () => enrollService(7, 44, USER_GORAKHPUR),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    }
  );
});