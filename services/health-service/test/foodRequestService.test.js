import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  listQueue,
  listRequests,
  REQUESTS_PER_DAY,
  requestFood,
  resolveRequest,
} from '../services/ledger/foodRequestService.js';
import { rankFoods } from '../services/ledger/foodMatch.js';

// The missing-food request flow, tested as three things that can each go wrong
// quietly:
//
//   1. The catalogue re-check on write. The client says "we don't have X" and
//      the catalogue can change under it, so trusting the client creates
//      duplicates for foods we already have.
//   2. Duplicate collapsing. A hundred people asking for omelette is one queue
//      entry with a hundred on it. If that is two hundred entries, the queue is
//      unusable and the feature is worse than not having it.
//   3. The paths that must not exist. Nothing here writes FoodItem. A test that
//      asserts the absence of a call is worth more here than one that asserts
//      the presence of a call, because the failure is invisible: the row still
//      gets created, the request still succeeds, and the only symptom is a
//      nutrient value in somebody's ledger that a user typed at 11pm.
//
// A mock prisma rather than a real database. What is under test is the
// decisions this service makes, and every one of them is visible in the calls it
// makes and the shape of what it returns.

function mockPrisma(overrides = {}) {
  return {
    foodItem: { findMany: async () => [], ...overrides.foodItem },
    foodRequest: {
      findFirst: async () => null,
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async (a) => ({ id: 1, ...a.data }),
      update: async (a) => ({ id: Number(a.where.id), ...a.data }),
      ...overrides.foodRequest,
    },
  };
}

const expectReject = async (fn, status, code) => {
  await assert.rejects(fn, (err) => {
    assert.equal(err.status, status, `expected status ${status}, got ${err.status}: ${err.message}`);
    assert.equal(err.code, code);
    return true;
  });
};

// --- name validation --------------------------------------------------------

test('a name is required', async () => {
  await expectReject(
    () => requestFood(mockPrisma(), { userId: 7, name: '  ' }),
    400,
    'NAME_REQUIRED',
  );
});

test('a single character is not a food name', async () => {
  await expectReject(() => requestFood(mockPrisma(), { userId: 7, name: 'x' }), 400, 'NAME_REQUIRED');
});

test('an over-long name is truncated rather than rejected', async () => {
  // Truncating is right here: the user is trying to tell us what they want, and
  // refusing because they added a brand name is the opposite of useful. The
  // stored value is what a reviewer will read, so it has to be a real name.
  let created;
  const prisma = mockPrisma({
    foodRequest: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  await requestFood(prisma, { userId: 7, name: `${'omelette'.repeat(20)}` });
  assert.ok(created.name.length <= 80);
});

test('whitespace inside a name is collapsed', async () => {
  // Otherwise "omelette,  cooked" and "omelette, cooked" are two queue entries
  // for the same dish and the count splits across both.
  let created;
  const prisma = mockPrisma({
    foodRequest: { create: async (a) => ((created = a.data), { id: 1, ...a.data }) },
  });
  await requestFood(prisma, { userId: 7, name: '  chicken   65  ' });
  assert.equal(created.name, 'chicken 65');
});

// --- rule 1: a request is not a food ----------------------------------------

test('nothing in this service writes a FoodItem', async () => {
  const calls = [];
  const prisma = mockPrisma({
    foodItem: {
      findMany: async () => {
        calls.push('findMany');
        return [];
      },
      create: async () => {
        calls.push('create');
        return {};
      },
      upsert: async () => {
        calls.push('upsert');
        return {};
      },
    },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos, steamed' });
  assert.deepEqual(calls, ['findMany'], 'foodItem was written to');
});

test('resolveRequest does not write a FoodItem either', async () => {
  // The tempting shortcut: "resolved" means we added it, so add it here. That
  // would turn a reviewer's two taps into an unreviewed nutrient row.
  const calls = [];
  const prisma = mockPrisma({
    foodItem: { create: async () => calls.push('create'), upsert: async () => calls.push('upsert') },
    foodRequest: { findUnique: async () => ({ id: 5, name: 'Momos' }) },
  });
  await resolveRequest(prisma, { id: 5, status: 'resolved' });
  assert.deepEqual(calls, []);
});

// --- rule 2: the catalogue is re-checked on write ----------------------------

test('a food the catalogue already has is refused rather than queued', async () => {
  const prisma = mockPrisma({
    foodItem: {
      findMany: async () => [{ id: 3, name: 'Omelette, cooked', basis: 'cooked', verified: false }],
    },
  });
  await expectReject(() => requestFood(prisma, { userId: 7, name: 'Omelette' }), 409, 'FOOD_EXISTS');
});

test('the 409 carries the rows, so the client can show them', async () => {
  // The whole point of the 409 over a 400: the user asked for something they
  // were one tap from. An error toast on a screen where somebody is trying to
  // log dinner is a failure; handing back the food is the whole fix.
  const prisma = mockPrisma({
    foodItem: {
      findMany: async () => [{ id: 3, name: 'Omelette, cooked', basis: 'cooked', verified: false }],
    },
  });
  await assert.rejects(
    () => requestFood(prisma, { userId: 7, name: 'Omelette' }),
    (err) => {
      assert.equal(err.code, 'FOOD_EXISTS');
      assert.equal(err.foods.length, 1);
      assert.equal(err.foods[0].name, 'Omelette, cooked');
      return true;
    },
  );
});

test('the re-check looks for the original query, not just the typed name', async () => {
  // A user who searched "masala dosa with chutney" and typed "dosa" as the name
  // is describing the row they could not find. Checking only the name would say
  // "no results" and queue a request for a food that is right there.
  //
  // The aliases are the real ones from prisma/seed/foods.seed.js, and they have
  // to be here. validateName scores the prefiltered rows with rankFoods now - the
  // picker, not a substring test - so a mock row with no aliases scores 0 for
  // this query and the test passes or fails on the mock's shape rather than on
  // the behaviour. "Dosa, masala" carries this alias in the seeded catalogue;
  // a mock that leaves it out is a worse kind of stub, because it disagrees with
  // the database in exactly the field under test.
  const prisma = mockPrisma({
    foodItem: {
      findMany: async () => [{
        id: 9,
        name: 'Dosa, masala',
        basis: 'cooked',
        verified: false,
        aliases: ['masala dosa', 'masala dosa with chutney'],
      }],
    },
  });
  await expectReject(
    () => requestFood(prisma, { userId: 7, name: 'dosa', query: 'masala dosa with chutney' }),
    409,
    'FOOD_EXISTS',
  );
});

test('the re-check and the picker cannot disagree about what exists', async () => {
  // The failure this guards against is a divergence, not a lookup.
  // validateName and searchFoods run the same scorer over the same haystack, so
  // any query they answer differently is a bug in one of them. The case that
  // separated them was "ice": SQL contains finds it inside "rice, cooked",
  // word-start does not, and the user who searched "ice" saw an empty picker and
  // was then told they already had rice.
  const rice = { id: 1, name: 'Rice, cooked', basis: 'cooked', verified: false, aliases: [] };

  // What the picker shows, which is the thing the re-check has to agree with.
  assert.deepEqual(rankFoods([rice], 'ice'), [], 'the picker shows nothing for "ice"');

  // The prefilter is deliberately loose, so SQL hands back that same row anyway.
  // The re-check must still end in a queued request rather than a 409.
  const prisma = mockPrisma({ foodItem: { findMany: async () => [rice] } });
  const { created } = await requestFood(prisma, { userId: 7, name: 'ice', query: 'ice' });
  assert.equal(created, true, 'a row the picker hides must not block a request');

  // And the converse still holds, so this is agreement rather than a blanket
  // loosening: a row the picker really would show is still caught as a duplicate.
  const prismaWithOmelette = mockPrisma({
    foodItem: {
      findMany: async () => [{
        id: 2, name: 'Omelette, cooked', basis: 'cooked', verified: false, aliases: ['omelette'],
      }],
    },
  });
  await expectReject(
    () => requestFood(prismaWithOmelette, { userId: 7, name: 'omelette', query: 'omelette' }),
    409,
    'FOOD_EXISTS',
  );
});

test('a genuinely missing food is queued', async () => {
  const { request, created } = await requestFood(mockPrisma(), { userId: 7, name: 'Momos, steamed' });
  assert.equal(created, true);
  assert.equal(request.status, 'pending');
  assert.equal(request.requestCount, 1);
  assert.equal(request.userId, 7);
});

// --- rule 3: duplicates collapse ---------------------------------------------

test('a second ask for the same dish increments the count instead of adding a row', async () => {
  let updates = 0;
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => ({ id: 4, name: 'Momos, steamed', detail: null, query: null, requestCount: 1 }),
      update: async (a) => {
        updates++;
        return { id: 4, ...a.data };
      },
    },
  });
  const { request, created } = await requestFood(prisma, { userId: 7, name: 'momos steamed' });
  assert.equal(created, false);
  assert.equal(updates, 1);
  assert.deepEqual(request.requestCount, { increment: 1 });
});

test('the duplicate match ignores case', async () => {
  // Otherwise "Momos" and "momos" are two entries and the count splits.
  let seen;
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async (a) => ((seen = a.where), null),
    },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos, steamed' });
  assert.deepEqual(seen.name, { equals: 'Momos, steamed', mode: 'insensitive' });
});

test('the duplicate match is scoped to the user', async () => {
  // Two different users asking for the same dish should NOT collapse into one
  // row - the row carries a userId, and merging them would attribute one
  // person's request to another and make the erasure path wrong.
  let seen;
  const prisma = mockPrisma({
    foodRequest: { findFirst: async (a) => ((seen = a.where), null) },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos' });
  assert.equal(seen.userId, 7);
});

test('a repeat ask does not overwrite a detail with an empty one', async () => {
  // Someone who first wrote a brand and then re-asked has given us less the
  // second time, not more. Overwriting with null destroys the only useful part.
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => ({ id: 4, name: 'Momos', detail: 'Tibetan momo stall, MG Road', query: 'momos' }),
      update: async (a) => ((data = a.data), { id: 4 }),
    },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos' });
  assert.equal(data.detail, 'Tibetan momo stall, MG Road');
});

test('a repeat ask with a new detail replaces the old one', async () => {
  // Concatenating two attempts produces something no reviewer triages.
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => ({ id: 4, name: 'Momos', detail: 'stall', query: null }),
      update: async (a) => ((data = a.data), { id: 4 }),
    },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos', detail: 'Tibetan, steamed not fried' });
  assert.equal(data.detail, 'Tibetan, steamed not fried');
});

test('a declined request is reopened, and the old rejection note is cleared', async () => {
  // Leaving a stale note on a reopened row means the next reviewer reads a
  // decision that no longer stands and closes it again for the same reason.
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => ({ id: 4, name: 'Momos', status: 'declined', detail: null, query: null }),
      update: async (a) => ((data = a.data), { id: 4 }),
    },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos' });
  assert.equal(data.status, 'pending');
  assert.equal(data.resolvedAt, null);
  assert.equal(data.reviewNote, null);
});

test('reopening does not reset the count', async () => {
  // Demand is a property of the dish. Zeroing it on the second ask would make a
  // dish people keep wanting look like a one-off to whoever reviews the queue.
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => ({ id: 4, name: 'Momos', status: 'declined', detail: null, query: null }),
      update: async (a) => ((data = a.data), { id: 4 }),
    },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos' });
  assert.deepEqual(data.requestCount, { increment: 1 });
});

// --- rate limiting ----------------------------------------------------------

test('the daily cap counts rows, not asks', async () => {
  // The distinction is the point of the cap: ten taps for one dish adds zero
  // rows, ten different dishes adds ten. Counting asks would rate-limit the
  // retry behaviour this file is built to absorb.
  let seen;
  const prisma = mockPrisma({
    foodRequest: { count: async (a) => ((seen = a.where), 0) },
  });
  await requestFood(prisma, { userId: 7, name: 'Momos' });
  assert.equal(seen.userId, 7);
  assert.ok(seen.createdAt.gte instanceof Date, 'the window must be a date bound, not a day string');
});

test('a user over the cap is refused with a 429', async () => {
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => null,
      count: async () => REQUESTS_PER_DAY,
    },
  });
  await expectReject(() => requestFood(prisma, { userId: 7, name: 'Momos' }), 429, 'RATE_LIMITED');
});

test('being at the cap does not stop you updating a request you already made', async () => {
  // The order of the cap and the dedupe is the behaviour. `count` says the user
  // is over the limit, findFirst says the dish is already queued - and the ask
  // has to succeed, because it adds no row and the cap counts rows. Found by
  // test/foodDb.test.js against a real database; every mock in this file answers
  // findFirst with null, so the update path was never paired with a full cap.
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => ({ id: 4, name: 'Momos', detail: null, query: null, requestCount: 3 }),
      count: async () => REQUESTS_PER_DAY,
      update: async (a) => ({ id: 4, requestCount: 4, ...a.data }),
    },
  });

  const { created, request } = await requestFood(prisma, { userId: 7, name: 'Momos' });
  assert.equal(created, false, 'an existing request is updated, never re-created');
  assert.equal(request.id, 4);
});

test('the cap is checked on the way to creating a row', async () => {
  // The same condition as above, from the other side: with no existing row the
  // cap has to bite. If this ever passes silently, the limit has stopped applying
  // to anyone.
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => null,
      count: async () => REQUESTS_PER_DAY,
    },
  });
  await expectReject(() => requestFood(prisma, { userId: 7, name: 'Momos' }), 429, 'RATE_LIMITED');
});

test('the cap is checked against the CALLER, not a name on the object', async () => {
  // The bug this pins: the limit was written against a field of the name
  // argument, which is a string, so it silently passed undefined and the cap
  // never applied to anybody. The count query is the only way to observe it.
  let countedFor = null;
  const prisma = mockPrisma({
    foodRequest: {
      findFirst: async () => null,
      count: async (a) => {
        countedFor = a.where.userId;
        return 0;
      },
    },
  });
  await requestFood(prisma, { userId: 42, name: 'Momos' });
  assert.equal(countedFor, 42);
});

test('the cap is not consulted when the food already exists', async () => {
  // The 409 is the more useful answer and it is free; a user asking for
  // something we have should never be told they have asked too much.
  let counted = false;
  const prisma = mockPrisma({
    foodItem: { findMany: async () => [{ id: 1, name: 'Omelette' }] },
    foodRequest: { count: async () => ((counted = true), 99) },
  });
  await assert.rejects(() => requestFood(prisma, { userId: 7, name: 'Omelette' }));
  assert.equal(counted, false);
});

// --- reads ------------------------------------------------------------------

test('listRequests is scoped to the caller', async () => {
  let seen;
  const prisma = mockPrisma({
    foodRequest: { findMany: async (a) => ((seen = a.where), []) },
  });
  await listRequests(prisma, { userId: 7 });
  assert.equal(seen.userId, 7);
});

test('a bad status filter is dropped rather than passed to Prisma', async () => {
  // Prisma would throw on an unknown enum value, which arrives as a 500 that
  // looks like a server fault on something the client controls.
  let seen;
  const prisma = mockPrisma({
    foodRequest: { findMany: async (a) => ((seen = a.where), []) },
  });
  await listRequests(prisma, { userId: 7, status: 'deleted' });
  assert.ok(!('status' in seen));
});

test('a valid status filter is applied', async () => {
  let seen;
  const prisma = mockPrisma({
    foodRequest: { findMany: async (a) => ((seen = a.where), []) },
  });
  await listRequests(prisma, { userId: 7, status: 'pending' });
  assert.equal(seen.status, 'pending');
});

test('the queue is ordered by demand, then oldest', async () => {
  // Newest-first would rank one request from an hour ago above a dish thirty
  // people asked for. The queue answers "what should we add next", and that
  // question is answered by the count, not by recency.
  let seen;
  const prisma = mockPrisma({
    foodRequest: { findMany: async (a) => ((seen = a.orderBy), []) },
  });
  await listQueue(prisma, {});
  assert.deepEqual(seen, [{ requestCount: 'desc' }, { createdAt: 'asc' }]);
});

test('the queue defaults to pending only', async () => {
  let seen;
  const prisma = mockPrisma({
    foodRequest: { findMany: async (a) => ((seen = a.where), []) },
  });
  await listQueue(prisma, {});
  assert.deepEqual(seen, { status: 'pending' });
});

test('the queue can be asked for every status', async () => {
  let seen;
  const prisma = mockPrisma({
    foodRequest: { findMany: async (a) => ((seen = a.where), []) },
  });
  await listQueue(prisma, { status: 'all' });
  assert.deepEqual(seen, {});
});

// --- resolution -------------------------------------------------------------

test('an unknown status is refused', async () => {
  await expectReject(
    () => resolveRequest(mockPrisma(), { id: 1, status: 'deleted' }),
    400,
    'BAD_STATUS',
  );
});

test('a missing request is a 404, not a crash', async () => {
  const prisma = mockPrisma({ foodRequest: { findUnique: async () => null } });
  await expectReject(() => resolveRequest(prisma, { id: 999, status: 'resolved' }), 404, 'NO_SUCH_REQUEST');
});

test('resolving stamps a time and keeps the reviewer note', async () => {
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findUnique: async () => ({ id: 5, name: 'Momos' }),
      update: async (a) => ((data = a.data), { id: 5 }),
    },
  });
  await resolveRequest(prisma, { id: 5, status: 'resolved', reviewNote: 'seeded from IFCT 2024' });
  assert.equal(data.status, 'resolved');
  assert.ok(data.resolvedAt instanceof Date);
  assert.equal(data.reviewNote, 'seeded from IFCT 2024');
});

test('declining also stamps a time', async () => {
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findUnique: async () => ({ id: 5, name: 'Momos' }),
      update: async (a) => ((data = a.data), { id: 5 }),
    },
  });
  await resolveRequest(prisma, { id: 5, status: 'declined', reviewNote: 'no single profile' });
  assert.ok(data.resolvedAt instanceof Date);
});

test('re-opening from the queue clears the time', async () => {
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findUnique: async () => ({ id: 5, name: 'Momos' }),
      update: async (a) => ((data = a.data), { id: 5 }),
    },
  });
  await resolveRequest(prisma, { id: 5, status: 'pending' });
  assert.equal(data.resolvedAt, null);
});

test('the reviewer note is clamped like everything else', async () => {
  let data;
  const prisma = mockPrisma({
    foodRequest: {
      findUnique: async () => ({ id: 5, name: 'Momos' }),
      update: async (a) => ((data = a.data), { id: 5 }),
    },
  });
  await resolveRequest(prisma, { id: 5, status: 'resolved', reviewNote: 'x'.repeat(2000) });
  assert.ok(data.reviewNote.length <= 500);
});

test('a non-numeric id does not reach Prisma', async () => {
  // findUnique with a string id is a client type error, and this route takes the
  // id straight from a path segment.
  let seen = null;
  const prisma = mockPrisma({
    foodRequest: {
      findUnique: async (a) => ((seen = a.where.id), null),
    },
  });
  await assert.rejects(() => resolveRequest(prisma, { id: 'abc', status: 'resolved' }));
  assert.equal(typeof seen, 'number');
});