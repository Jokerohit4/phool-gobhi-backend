// "I could not find this food, please add it."
//
// The catalogue is hand-written and finite; a user searching "omelette" and
// getting nothing could only give up on logging, log something adjacent and
// wrong, or write the same note in a free-text field nobody reads. This is the
// third option, and it doubles as the growth backlog: these rows are
// real-demand-ordered, which is a better input for "what should we add next"
// than a guess at what people eat.
//
// Three rules, and they are the reason this is a small file:
//
//   1. A REQUEST IS NOT A FOOD. Nothing here writes FoodItem. There is no
//      endpoint that takes a name from a user and turns it into a nutrient
//      value, and adding one would let anybody create a row that looks like
//      signed-off reference data and is a guess typed at 11pm. The catalogue
//      grows by seeding, from someone who can source a number.
//
//   2. THE SEARCH IS RE-CHECKED ON WRITE. If a row appeared since the client
//      rendered its empty state - a re-seed while the picker was open, or a
//      user who had already asked and been answered - this must not queue a
//      duplicate. The client says "we don't have X" and the server re-checking
//      is the only way that stays true while the two disagree.
//
//   3. DUPLICATES ARE THE NORMAL CASE, NOT THE EDGE CASE. A hundred people
//      asking for omelette is one request with one hundred votes, not a hundred
//      rows. `requestCount` carries the signal that makes the backlog useful,
//      and collapsing duplicates keeps the queue ranked by demand.
import { FOOD_REQUEST_STATUSES } from './constants.js';
import { rankFoods } from './foodMatch.js';

// A dish name. Long enough for "chicken sukka (restaurant style)" and short
// enough that the field cannot become a place to write an essay about somebody's
// diet.
const NAME_MAX = 80;
const DETAIL_MAX = 500;
const QUERY_MAX = 80;

// Per user, per day, counting rows CREATED rather than asks. The distinction
// matters and is the whole point of the cap: a retry loop or a bored user
// tapping submit ten times for one dish adds zero rows - the counter absorbs
// it - while ten different dishes in a minute adds ten, and ten rows of
// unvetted free text is what makes a queue nobody wants to work through.
// Counting asks instead would rate-limit the exact behaviour this file is
// designed to absorb.
export const REQUESTS_PER_DAY = 10;

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

/**
 * Records one missing food.
 *
 * Returns the request and whether it was newly created. An existing PENDING
 * request for the same dish absorbs the new one and has its count incremented,
 * so repeated asking never creates a second queue entry - the count is the
 * whole value of the backlog.
 *
 * A previously DECLINED request is reopened rather than duplicated: if the user
 * wants it again, the answer that was given did not convince them, and hiding
 * that behind a resolved row would lose the only signal that says so.
 *
 * `requestCount` is NOT reset on reopen. How often a dish has been asked for is
 * a property of the dish, not of one request, and zeroing it on the second ask
 * would make a dish people keep wanting look like a one-off to whoever reviews
 * the queue.
 */
export async function requestFood(
  prisma,
  { userId, name, query, detail, now = new Date() },
) {
  const cleanName = await validateName(prisma, { name, query });
  const cleanQuery = clamp(query, QUERY_MAX);
  const cleanDetail = clamp(detail, DETAIL_MAX);

  const existing = await prisma.foodRequest.findFirst({
    where: {
      userId,
      name: { equals: cleanName, mode: 'insensitive' },
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  if (existing) {
    const updated = await prisma.foodRequest.update({
      where: { id: existing.id },
      data: {
        // A second ask from a pending row only moves the counter. A second ask
        // against a declined one reopens it, and `pending` is the default so the
        // resolvedAt and reviewNote from the last decision are cleared - leaving
        // a stale rejection note on a row that is now open again would have the
        // next reviewer reading a note about a decision that no longer stands.
        status: 'pending',
        resolvedAt: null,
        reviewNote: null,
        requestCount: { increment: 1 },
        // Detail is overwritten, not appended. Someone who first asked with no
        // detail and then added the brand is giving us strictly more
        // information, and concatenating two attempts produces a mess nobody
        // triages.
        detail: cleanDetail || existing.detail,
        query: cleanQuery || existing.query,
      },
    });
    return { request: updated, created: false };
  }

  // The cap is checked HERE, on the way to creating a row, and not earlier in
  // validateName. The order is the whole behaviour: an ask that lands on an
  // existing row adds nothing to the queue, so it must not be able to hit the
  // cap. Checking the limit before the dedupe meant a user who had reached ten
  // rows could no longer add detail to, or re-open, a request they had already
  // made - the exact retry this cap exists to absorb. Found by the real-database
  // test, not the mocked one: the mocks answer findFirst with null, so the
  // update path was never exercised alongside the cap.
  await assertWithinDailyLimit(prisma, { userId, now });

  const created = await prisma.foodRequest.create({
    data: {
      userId,
      name: cleanName,
      query: cleanQuery,
      detail: cleanDetail,
      status: 'pending',
      requestCount: 1,
    },
  });
  return { request: created, created: true };
}

/**
 * The user's own requests, newest first.
 *
 * Scoped by userId the same way every read in this service is - a request is a
 * record of what this person eats and what they could not find, which is
 * exactly the kind of thing the ledger does not expose to anyone else.
 */
export async function listRequests(prisma, { userId, status, limit = 50 } = {}) {
  return prisma.foodRequest.findMany({
    where: {
      userId,
      ...(status && FOOD_REQUEST_STATUSES.includes(status) ? { status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(Number(limit) || 50, 100),
  });
}

/**
 * The queue, for a reviewer.
 *
 * Demand-ordered within pending: requestCount first, then oldest. That is the
 * ranking that answers "what should we add next" - a dish twenty people asked
 * for this week outranks one person asking twice a month - and newest-first
 * would rank a single request from an hour ago above a dish that has been asked
 * for thirty times.
 */
export async function listQueue(prisma, { status = 'pending', limit = 100 } = {}) {
  return prisma.foodRequest.findMany({
    where: status === 'all' ? {} : { status },
    orderBy: [{ requestCount: 'desc' }, { createdAt: 'asc' }],
    take: Math.min(Number(limit) || 100, 200),
  });
}

/**
 * Marks a request resolved or declined.
 *
 * The reviewer names the outcome; this never infers one. A request cannot be
 * marked resolved by anything a user does, and there is no path from here to
 * FoodItem - the row that would carry the nutrients is written by a person
 * seeding the catalogue, after sourcing values.
 */
export async function resolveRequest(prisma, { id, status, reviewNote }) {
  if (!FOOD_REQUEST_STATUSES.includes(status)) {
    throw badRequest('Unknown request status', 'BAD_STATUS');
  }
  const found = await prisma.foodRequest.findUnique({ where: { id: Number(id) } });
  if (!found) {
    throw Object.assign(new Error('No such food request'), {
      status: 404,
      code: 'NO_SUCH_REQUEST',
    });
  }

  return prisma.foodRequest.update({
    where: { id: found.id },
    data: {
      status,
      reviewNote: clamp(reviewNote, DETAIL_MAX),
      resolvedAt: status === 'pending' ? null : new Date(),
    },
  });
}

async function validateName(prisma, { name, query }) {
  const clean = clamp(name, NAME_MAX);
  if (!clean || clean.length < 2) {
    throw badRequest('Name the food you were looking for', 'NAME_REQUIRED');
  }

  // Rule 2. Checked here rather than trusted from the client, because the
  // client's answer was true when it rendered and the catalogue can change
  // under it - a re-seed lands in seconds and the picker does not refetch.
  //
// Matched against the same haystack the picker searches, and then judged by
  // the same scorer, because "the same haystack" is not the same question.
  //
  // SQL contains is an arbitrary substring test. It is the right thing to use as
  // a cheap prefilter - it has to be broad or it misses the row - but it accepts
  // "ice" inside "rice, cooked" and "tea" inside "steamed", which is precisely
  // what scoreMatch exists to reject. Filtering on the prefilter's verdict alone
  // means this answers 409 "we already have that food" for a row the picker is
  // not showing, and a user who searched "ice" and then submitted a request would
  // be told they already have rice. rankFoods is the picker, so using it here is
  // what makes the two answers the same answer.
  //
  // Deliberately not a typo-tolerant match. If this said "we have it" for a row
  // the user cannot see in search, the fix would look broken in a worse way than
  // a duplicate request. "omlet" still gets queued - which is the honest outcome,
  // since it is also the next item on the seed backlog.
  const needle = clamp(query, QUERY_MAX) || clean;
  const candidates = await prisma.foodItem.findMany({
    where: { searchText: { contains: needle.toLowerCase(), mode: 'insensitive' } },
    // aliases are selected because scoreMatch scores the alias tiers; without
    // them every row would look like it had no aliases and be scored on the name
    // alone.
    select: { id: true, name: true, basis: true, verified: true, aliases: true },
    // No take. A cap here reintroduces the bug this service started with - the
    // right row sorted past the limit and the user is told it does not exist. The
    // prefilter is deliberately loose, so the candidate list is larger than the
    // result list, but it is bounded by the catalogue rather than by a constant
    // that guesswork picked.
  });
const existing = rankFoods(candidates, needle).slice(0, 5);
  if (existing.length) {
    throw Object.assign(new Error('We already have that food'), {
      status: 409,
      // The rows, so the client can show them instead of an error toast. The
      // user asked for something they were already one tap from.
      code: 'FOOD_EXISTS',
      foods: existing,
    });
  }

  return clean;
}

async function assertWithinDailyLimit(prisma, { userId, now }) {
  if (!userId) return;
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const used = await prisma.foodRequest.count({
    where: { userId, createdAt: { gte: since } },
  });
  if (used >= REQUESTS_PER_DAY) {
    throw Object.assign(new Error('Too many requests today. Try again tomorrow.'), {
      status: 429,
      code: 'RATE_LIMITED',
    });
  }
}

function clamp(value, max) {
  const trimmed = String(value ?? '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : null;
}