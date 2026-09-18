// Partner-vs-unclaimed matching (services/unclaimedGymService.js).
//
// This is the riskiest logic in the non-partner-gym feature, because both
// failure directions cost something real:
//   false negative -> we shadow a partner gym with an unclaimed row, and that
//                     customer silently loses booking/PAYG for a gym we sell.
//   false positive -> attendance is attributed to a gym the customer never
//                     entered, which corrupts both their streak and that
//                     partner's numbers.
// The table below is the specification for where that line sits.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let matchPartnerGymService;
const findMany = { calls: [], result: [] };

test('setup: stub Prisma and import the service', async (t) => {
  // The service constructs its own PrismaClient at module scope, so the client
  // is mocked rather than the database — this keeps the test about the
  // matching rule and not about having a Postgres.
  t.mock.module('@prisma/client', {
    namedExports: {
      PrismaClient: class {
        constructor() {
          this.gym = {
            findMany: async (args) => {
              findMany.calls.push(args);
              return findMany.result;
            },
          };
        }
      },
    },
  });
  ({ matchPartnerGymService } = await import('../services/unclaimedGymService.js'));
});

function gym(over = {}) {
  return { id: 1, name: "Gold's Gym", lat: 28.4595, lng: 77.0266, ...over };
}

test('same place, punctuation and filler words differing -> match', async () => {
  findMany.result = [gym({ name: "Gold's Gym (Sector 39)" })];
  const id = await matchPartnerGymService({
    name: 'Golds Gym Sector 39',
    lat: 28.4595,
    lng: 77.0266,
  });
  assert.equal(id, 1);
});

test('"Fitness"/"Centre" are filler and do not by themselves create a match', async () => {
  // Two genuinely different gyms in one building would otherwise collide on
  // the word "Fitness" alone.
  findMany.result = [gym({ id: 7, name: 'Anytime Fitness' })];
  const id = await matchPartnerGymService({
    name: 'Snap Fitness',
    lat: 28.4595,
    lng: 77.0266,
  });
  assert.equal(id, null);
});

test('same chain, different branch across town -> no match', async () => {
  // Name alone would match. Distance is what stops attendance being credited
  // to a branch the customer has never walked into.
  findMany.result = [];
  const id = await matchPartnerGymService({
    name: "Gold's Gym",
    lat: 28.7041,
    lng: 77.1025,
  });
  assert.equal(id, null);
});

test('near but beyond the radius -> no match', async () => {
  // ~0.0018 degrees latitude is roughly 200m, past the 150m cutoff.
  findMany.result = [gym({ lat: 28.4613, lng: 77.0266 })];
  const id = await matchPartnerGymService({
    name: "Gold's Gym",
    lat: 28.4595,
    lng: 77.0266,
  });
  assert.equal(id, null);
});

test('missing coordinates -> no match, and no query is attempted', async () => {
  findMany.calls.length = 0;
  findMany.result = [gym()];
  assert.equal(await matchPartnerGymService({ name: 'x', lat: null, lng: null }), null);
  assert.equal(await matchPartnerGymService({ name: 'x' }), null);
  assert.equal(findMany.calls.length, 0);
});

test('a nameless place never matches', async () => {
  // Better to create an unclaimed row than to guess: the customer can still
  // check in, and nobody else's numbers are touched.
  findMany.result = [gym()];
  const id = await matchPartnerGymService({ name: '', lat: 28.4595, lng: 77.0266 });
  assert.equal(id, null);
});

test('candidate query is bounded by a box rather than scanning every gym', async () => {
  findMany.calls.length = 0;
  findMany.result = [];
  await matchPartnerGymService({ name: 'x', lat: 28.4595, lng: 77.0266 });
  const where = findMany.calls[0].where;
  assert.ok(where.lat.gte < 28.4595 && where.lat.lte > 28.4595);
  assert.ok(where.lng.gte < 77.0266 && where.lng.lte > 77.0266);
});
