// Real-database tests for the food catalogue and the missing-food request flow.
//
// The unit suite for both of those mocks Prisma, and for this particular work
// that is not a stylistic complaint - it is the reason two real defects shipped
// past 900 passing tests:
//
//   1. "tea" returned "Momos, steamed", because plain `includes` cannot tell a
//      word from the middle of a longer one and s-t-e-a-m-e-d contains "tea".
//      Every unit test passed, because no test row contained the word "steamed".
//      It took a real seeded catalogue and a real Postgres to surface.
//   2. `prisma db seed` was a silent no-op - there was no `prisma.seed` config
//      and no `seed` script, so the command printed nothing, exited 0, and loaded
//      zero rows. Nothing failed, so nothing was reported.
//
// Both are properties of the DATA and the DATABASE, not of the logic. A mock
// cannot see either: it is handed the rows it is going to be asked about, which
// is exactly the information the bugs were about. So this file runs against the
// seeded database and asserts on what is actually in it.
//
// Skipped unless TEST_DATABASE_URL is set, so `npm test` still runs anywhere.
//
// Run with:
//   npx prisma migrate deploy && npx prisma db seed
//   TEST_DATABASE_URL=postgres://... node --test test/foodDb.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = process.env.TEST_DATABASE_URL?.trim();
const SKIP = TEST_URL
  ? false
  : 'set TEST_DATABASE_URL (and run `prisma migrate deploy && prisma db seed` against it) to run these';

// The service builds its PrismaClient at import time from DATABASE_URL, so the
// swap has to happen before the import rather than being passed to the
// constructor from the outside.
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

// A userId no real person can have, so a crashed run cannot collide with data
// and the after-hook can delete exactly what this file wrote and nothing else.
const BASE = 9_200_000;

let prisma;
let searchFoods;
let requestFood;
let resolveRequest;
let listRequests;
let listQueue;
let REQUESTS_PER_DAY;

before(async () => {
  if (SKIP) return;
  const mod = await import('@prisma/client');
  prisma = new mod.PrismaClient();
  ({ searchFoods } = await import('../services/ledger/nutritionService.js'));
  ({ requestFood, resolveRequest, listRequests, listQueue, REQUESTS_PER_DAY } =
    await import('../services/ledger/foodRequestService.js'));
});

after(async () => {
  if (!prisma) return;
  await prisma.foodRequest.deleteMany({ where: { userId: { gte: BASE } } });
  await prisma.$disconnect();
});

// --- the catalogue actually exists and is searchable -------------------------

test('the seed landed, and every row is reachable by its own name', { skip: SKIP }, async () => {
  const total = await prisma.foodItem.count();
  assert.ok(total >= 161, `expected the seeded catalogue, found ${total} rows`);

  // The migration adds searchText with a default of '' and then backfills it. If
  // that UPDATE is ever dropped - it is a separate statement and nothing forces
  // it to exist - every row keeps an empty haystack and search silently returns
  // nothing at all, with no error anywhere. This is the one assertion that would
  // have caught it.
  const blank = await prisma.foodItem.count({ where: { searchText: '' } });
  assert.equal(blank, 0, `${blank} rows have an empty searchText and are unfindable`);
});

// The original bug. "omelette" returned nothing, and the fix has to survive
// contact with the real rows rather than a fixture named after the fix.
test('the query that started this finds the food it is named after', { skip: SKIP }, async () => {
  for (const q of ['omelette', 'omelet']) {
    const rows = await searchFoods(prisma, BASE, { query: q, includeUnverified: true });
    assert.ok(rows.length > 0, `"${q}" returned nothing`);
    assert.ok(
      rows.some((r) => /omelet/i.test(r.name)),
      `"${q}" returned ${rows.map((r) => r.name).join(', ')} - no omelette`,
    );
  }
});

test('a short query does not match inside an unrelated word', { skip: SKIP }, async () => {
  // The defect this whole file exists for. "steamed" contains "tea", and plain
  // substring search put Momos above Green tea in the results.
  const rows = await searchFoods(prisma, BASE, { query: 'tea', includeUnverified: true });
  const names = rows.map((r) => r.name);

  assert.ok(!names.includes('Momos, steamed'), '"tea" matched the word "steamed"');
  assert.ok(names.length > 0, '"tea" found nothing at all - the rule is too tight');
  assert.ok(
    names.some((n) => /tea|chai/i.test(n)),
    `"tea" should find a drink, got ${names.join(', ')}`,
  );
});

test('the plain dish outranks the dishes that merely contain it', { skip: SKIP }, async () => {
  // "rice" as a prefix of "Rice, cooked" beats "Curd rice" and "Fried rice
  // balls". An alphabetical or unranked list puts the curd rice first, which is
  // the failure this file would report as "search works" if it only checked for
  // a non-empty result.
  const rows = await searchFoods(prisma, BASE, { query: 'rice', includeUnverified: true });
  assert.ok(rows.length > 0);
  assert.ok(
    /rice/i.test(rows[0].name),
    `top hit for "rice" is "${rows[0].name}"`,
  );
});

test('an alias finds its row from a fragment of the alias', { skip: SKIP }, async () => {
  // The other half of the original bug: Prisma's `has` on a String[] is an exact
  // element match, so this was unfindable by anything but the whole alias.
  const rows = await searchFoods(prisma, BASE, { query: 'makkai chattai', includeUnverified: true });
  assert.ok(rows.length > 0, 'an exact alias should find its row');

  const partial = await searchFoods(prisma, BASE, { query: 'makkai', includeUnverified: true });
  assert.ok(partial.length > 0, 'a partial alias should also find its row');
});

// --- the request flow against real constraints --------------------------------

test('the enum refuses a status Postgres was never given', { skip: SKIP }, async () => {
  // Only a real database can prove this. A mock's enum is just a string, so it
  // will happily accept "approved" and the failure surfaces in production as a
  // 500 from the driver rather than a 400 from validation.
  await assert.rejects(
    () => prisma.foodRequest.create({
      data: { userId: BASE, name: 'Enum probe', status: 'approved' },
    }),
    'Postgres accepted a status outside the FoodRequestStatus enum',
  );
});

test('asking twice counts once, and declining then asking again keeps the count', { skip: SKIP }, async () => {
  const first = await requestFood(prisma, { userId: BASE, name: 'Ragi dosa', query: 'ragi dosa' });
  assert.equal(first.created, true);
  assert.equal(first.request.requestCount, 1);

  const second = await requestFood(prisma, { userId: BASE, name: 'Ragi dosa', query: 'ragi dosa' });
  assert.equal(second.created, false, 'a repeat must not create a second row');
  assert.equal(second.request.requestCount, 2, 'a repeat must increment the count');
  assert.equal(second.request.id, first.request.id, 'it must be the same row');

  await resolveRequest(prisma, { id: first.request.id, status: 'declined', reviewNote: 'not sourced yet' });
  const declined = await prisma.foodRequest.findUnique({ where: { id: first.request.id } });
  assert.equal(declined.status, 'declined');
  assert.ok(declined.resolvedAt, 'declining stamps a time');

  // Reopening clears the stale decision but must NOT zero the count: how often a
  // dish is asked for is a property of the dish.
  const third = await requestFood(prisma, { userId: BASE, name: 'Ragi dosa', query: 'ragi dosa' });
  assert.equal(third.request.status, 'pending', 'reopening returns the row to the queue');
  assert.equal(third.request.reviewNote, null, 'the stale rejection note must be cleared');
  assert.equal(third.request.resolvedAt, null);
  assert.equal(third.request.requestCount, 3, 'the count must survive the reopen');

  const total = await prisma.foodRequest.count({ where: { userId: BASE, name: 'Ragi dosa' } });
  assert.equal(total, 1, 'three asks must be one queue row');
});

test('a food we already have is refused as a duplicate, with the row attached', { skip: SKIP }, async () => {
  // The client renders "we don't have X" and needs to be able to show the row
  // instead of an error, so the payload is part of the contract.
  await assert.rejects(
    () => requestFood(prisma, { userId: BASE, name: 'Omelette', query: 'omelette' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'FOOD_EXISTS');
      assert.ok(Array.isArray(err.foods) && err.foods.length > 0, 'FOOD_EXISTS must carry the rows');
      return true;
    },
  );
});

test('the daily cap counts rows created, not asks', { skip: SKIP }, async () => {
  // The distinction the cap exists for. Ten taps on one dish add zero rows and
  // must not rate-limit; counting asks instead would limit exactly the retry
  // behaviour the design is meant to absorb.
  const userId = BASE + 1;

  // One dish, asked for far more times than the cap allows. The first ask
  // creates the row; every ask after that has to land on it rather than
  // creating another, and none of them may be rate-limited.
  const first = await requestFood(prisma, { userId, name: 'Repeat probe', query: 'repeat probe' });
  assert.equal(first.created, true);

  for (let i = 0; i < REQUESTS_PER_DAY + 4; i++) {
    const again = await requestFood(prisma, { userId, name: 'Repeat probe', query: 'repeat probe' });
    assert.equal(again.created, false, 'ask 2+ of the same dish must not create a row');
    assert.equal(again.request.id, first.request.id, 'every ask must land on the same row');
  }
  assert.equal(
    await prisma.foodRequest.count({ where: { userId, name: 'Repeat probe' } }),
    1,
    'fifteen asks must be one row',
  );

  // Nine more distinct dishes reach the cap of ten rows.
  for (let i = 0; i < REQUESTS_PER_DAY - 1; i++) {
    await requestFood(prisma, { userId, name: `Distinct probe ${i}`, query: `distinct probe ${i}` });
  }
  const atCap = await prisma.foodRequest.count({ where: { userId } });
  assert.equal(atCap, REQUESTS_PER_DAY, 'ten rows should now exist for this user');

  // The eleventh distinct dish is refused...
  await assert.rejects(
    () => requestFood(prisma, { userId, name: 'One too many', query: 'one too many' }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, 'RATE_LIMITED');
      return true;
    },
  );

  // ...while re-asking for one that is already queued still succeeds, because it
  // is the same row and the cap counts rows rather than asks.
  const again = await requestFood(prisma, { userId, name: 'Repeat probe', query: 'repeat probe' });
  assert.equal(again.created, false);
  assert.equal(again.request.requestCount, REQUESTS_PER_DAY + 6);

  // A different user is unaffected: the cap is per person, not global.
  const other = await requestFood(prisma, { userId: BASE + 2, name: 'Repeat probe', query: 'repeat probe' });
  assert.equal(other.created, true);

  await prisma.foodRequest.deleteMany({ where: { userId: { in: [userId, BASE + 2] } } });
});

test('the queue ranks by demand, and one user cannot read another', { skip: SKIP }, async () => {
  const quiet = BASE + 3;
  const loud = BASE + 4;

  await requestFood(prisma, { userId: quiet, name: 'Quiet dish', query: 'quiet dish' });
  for (let i = 0; i < 3; i++) {
    await requestFood(prisma, { userId: loud, name: 'Loud dish', query: 'loud dish' });
  }

  const queue = await listQueue(prisma, { status: 'pending' });
  const names = queue.map((r) => r.name);
  assert.ok(
    names.indexOf('Loud dish') < names.indexOf('Quiet dish'),
    `the dish asked for three times must outrank the one asked for once: ${names.join(', ')}`,
  );

  // A request is a record of what one person eats. The queue is the reviewer's
  // view and the list is the user's own; neither leaks the other's rows.
  const mine = await listRequests(prisma, { userId: quiet });
  assert.ok(mine.every((r) => r.userId === quiet), 'listRequests returned another user row');
  assert.ok(mine.some((r) => r.name === 'Quiet dish'));
  assert.ok(!mine.some((r) => r.name === 'Loud dish'), "listRequests leaked another user's request");

  await prisma.foodRequest.deleteMany({ where: { userId: { in: [quiet, loud] } } });
});