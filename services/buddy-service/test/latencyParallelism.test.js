// Latency pass: independent reads now run together. What must NOT change is
// pinned alongside the new concurrency:
//  - getMatches: suspension still wins and no data is returned to a suspended
//    caller, even when the match query is what fails first;
//  - getMessages (`after` poll): the participant guard still gates the response;
//  - getFeed: `me` / swiped / safety reads start together, a missing profile is
//    still a 400, and candidates are fetched with a field list (no include);
//  - consistency league: health POST and name lookup run together, carry a 3s
//    timeout, a name failure degrades to "Buddy", a health failure still fails.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const events = [];
const log = (e) => events.push(e);

const state = {
  profiles: new Map(), // userId -> profile
  matches: [],
  messages: [],
  matchById: new Map(),
  matchFindManyFails: false,
  candidateArgs: null,
  axiosCalls: [],
  axiosFails: false,
  namesFail: false,
};

function me(userId, overrides = {}) {
  return {
    id: 1000 + userId, userId, bio: null, socialMediaUrl: null, gender: null,
    dateOfBirth: new Date('1995-01-01'), fitnessGoals: [], lat: 28.6, lng: 77.2,
    isDiscoverable: true, isActive: true, moderationHoldAt: null, genderChangedAt: null,
    genderChangedTo: null, genderChangeClearedAt: null, womenOnlyBlocked: false,
    filter: null, photos: [],
    ...overrides,
  };
}

const fake = {
  buddyProfile: {
    findUnique: async ({ where, select }) => {
      log(select ? 'suspension:start' : 'me:start');
      await tick(10);
      const p = state.profiles.get(where.userId) ?? null;
      return select && p ? { isActive: p.isActive } : p;
    },
    findMany: async (args) => {
      if (args.where?.userId?.in) {
        log('profiles:start');
        await tick(10);
        return args.where.userId.in.map((id) => state.profiles.get(id)).filter(Boolean).map((p) => ({ ...p, photos: [] }));
      }
      state.candidateArgs = args;
      return [{
        userId: 7, publicCode: 'ABC', dateOfBirth: new Date('1996-01-01'), gender: null, bio: 'hi',
        socialMediaUrl: null, fitnessGoals: [], lat: 28.6, lng: 77.2,
        photos: [{ id: 1, url: 'u', order: 0 }], filter: { radiusKm: 50 },
      }];
    },
  },
  swipe: { findMany: async () => { log('swiped:start'); await tick(10); return []; } },
  blockedUser: { findMany: async () => { log('blocks:start'); await tick(10); return []; } },
  report: { findMany: async () => { log('reports:start'); await tick(10); return []; } },
  match: {
    findMany: async () => {
      log('matches:start');
      await tick(10);
      if (state.matchFindManyFails) throw new Error('db blew up');
      return state.matches;
    },
    findUnique: async ({ where }) => state.matchById.get(where.id) ?? null,
    update: async () => ({}),
  },
  chatMessage: {
    findMany: async () => { log('messages:start'); await tick(10); return state.messages; },
  },
};

let svc; let league;

test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class { constructor() { return fake; } }, Prisma: {} } });
  t.mock.module('../services/authClient.js', {
    exports: {
      getUserInternal: async () => ({ id: 1 }),
      getUsersBatchInternal: async (ids) => {
        log('names:start');
        await tick(10);
        if (state.namesFail) throw new Error('auth down');
        return ids.map((id) => ({ id, name: `N${id}`, profileImageUrl: '' }));
      },
    },
  });
  t.mock.module('../utils/notifyMatch.js', { exports: { notifyMatch: async () => {} } });
  t.mock.module('../utils/notifyMessage.js', { exports: { notifyMessage: async () => {} } });
  t.mock.module('../utils/analytics.js', { exports: { track: () => {} } });
  t.mock.module('../utils/geo.js', {
    exports: { haversineKm: () => 1, boundingBox: () => ({ minLat: 0, maxLat: 90, minLng: -180, maxLng: 180 }), bucketDistanceKm: () => '< 1 km' },
  });
  t.mock.module('../utils/tier.js', { exports: { assertTierAllows: () => {} } });
  t.mock.module('../utils/upload.js', { exports: { MAX_BUDDY_PHOTOS: 6 } });
  t.mock.module('../config/cloudinary.js', { exports: { default: { uploader: {} } } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', {
    exports: { default: {
      post: async (url, body, config) => {
        log('health:start');
        state.axiosCalls.push({ url, body, config });
        await tick(10);
        if (state.axiosFails) throw new Error('health down');
        return { data: { data: body.userIds.map((userId) => ({ userId, avgScore: userId })) } };
      },
    } },
  });
  svc = await import('../services/buddyService.js');
  league = await import('../services/leagueService.js');
});

function reset() {
  events.length = 0;
  state.profiles.clear(); state.matches = []; state.messages = []; state.matchById.clear();
  state.matchFindManyFails = false; state.candidateArgs = null; state.axiosCalls = []; state.axiosFails = false; state.namesFail = false;
}

// --- getMatches ---------------------------------------------------------------

test('getMatches: suspension check and match query start together', async () => {
  reset();
  state.profiles.set(1, me(1));
  await svc.getMatches(1);
  assert.deepEqual(events.slice(0, 2).sort(), ['matches:start', 'suspension:start']);
});

test('getMatches: a suspended caller gets the suspension error, not data', async () => {
  reset();
  state.profiles.set(1, me(1, { isActive: false }));
  state.matches = [{ id: 1, userLowId: 1, userHighId: 2, matchedAt: new Date(), messages: [] }];
  await assert.rejects(svc.getMatches(1), (e) => e.code === 'BUDDY_SUSPENDED' || /suspend/i.test(JSON.stringify(e)));
});

test('getMatches: suspension still wins when the match query is what fails', async () => {
  reset();
  state.profiles.set(1, me(1, { isActive: false }));
  state.matchFindManyFails = true;
  await assert.rejects(svc.getMatches(1), (e) => !(e instanceof Error && e.message === 'db blew up'));
});

// --- getMessages --------------------------------------------------------------

function activeMatch(id = 5) {
  state.matchById.set(id, { id, userLowId: 1, userHighId: 2, status: 'active', lastActivityAt: new Date(), matchedAt: new Date() });
  state.profiles.set(1, me(1)); state.profiles.set(2, me(2));
}

test('getMessages(after): messages query runs alongside the participant guard', async () => {
  reset();
  activeMatch();
  state.messages = [{ id: 9, matchId: 5, body: 'x' }];
  const out = await svc.getMessages(1, 5, { after: '3' });
  assert.deepEqual(out, state.messages);
  assert.ok(events.includes('messages:start') && events.includes('suspension:start'));
  assert.ok(events.indexOf('messages:start') < events.lastIndexOf('suspension:start') + 5);
});

test('getMessages(after): the guard still gates the response (not a participant -> 403, no rows)', async () => {
  reset();
  activeMatch();
  state.messages = [{ id: 9, matchId: 5, body: 'secret' }];
  await assert.rejects(svc.getMessages(99, 5, { after: '3' }), (e) => e.status === 403);
});

test('getMessages(after): unmatched/inactive match is still 410 with rows discarded', async () => {
  reset();
  activeMatch();
  state.matchById.set(5, { ...state.matchById.get(5), status: 'unmatched' });
  state.messages = [{ id: 9, matchId: 5, body: 'secret' }];
  await assert.rejects(svc.getMessages(1, 5, { after: '3' }), (e) => e.status === 410);
});

test('getMessages(before): unchanged ordering (oldest-first)', async () => {
  reset();
  activeMatch();
  state.messages = [{ id: 3 }, { id: 2 }];
  assert.deepEqual((await svc.getMessages(1, 5, { before: '9' })).map((m) => m.id), [2, 3]);
});

// --- getFeed ------------------------------------------------------------------

test('getFeed: me, swiped and safety reads start together; candidates use select', async () => {
  reset();
  state.profiles.set(1, me(1));
  const out = await svc.getFeed(1, {});
  for (const e of ['me:start', 'swiped:start', 'blocks:start']) assert.ok(events.indexOf(e) < 6, e);
  assert.equal(state.candidateArgs.include, undefined);
  assert.ok(state.candidateArgs.select.photos && state.candidateArgs.select.filter);
  assert.equal(out.data.length, 1);
  assert.equal(out.data[0].userId, 7);
  // A stranger gets the card only; the public code needs sharing switched on.
  assert.ok(!('publicCode' in out.data[0]));
  assert.ok(!('socialMediaUrl' in out.data[0]) && !('gender' in out.data[0]));
  assert.equal(state.candidateArgs.select.socialMediaUrl, undefined);
  assert.equal(state.candidateArgs.select.gender, undefined);
  assert.equal(out.data[0].bio, 'hi');
  assert.deepEqual(out.data[0].photos, [{ id: 1, url: 'u', order: 0 }]);
  assert.equal(out.data[0].distanceRange, '< 1 km');
  assert.equal(out.hasMore, false);
});

test('getFeed: a missing buddy profile is still a 400', async () => {
  reset();
  await assert.rejects(svc.getFeed(1, {}), (e) => e.status === 400);
});

// --- consistency league -------------------------------------------------------

function leagueMatch() {
  state.matches = [{ id: 1, userLowId: 1, userHighId: 2 }];
}

test('league: health POST and name lookup start together, with a 3s timeout', async () => {
  reset();
  leagueMatch();
  const out = await league.getConsistencyLeague(1);
  assert.ok(events.includes('health:start') && events.includes('names:start'));
  assert.ok(Math.abs(events.indexOf('health:start') - events.indexOf('names:start')) <= 1);
  assert.equal(state.axiosCalls[0].config.timeout, 3000);
  assert.ok('x-internal-key' in state.axiosCalls[0].config.headers);
  assert.deepEqual(out.league.map((r) => [r.userId, r.name, r.score, r.isMe]), [[2, 'N2', 2, false], [1, 'N1', 1, true]]);
  assert.equal(out.myRank, 2);
  assert.equal(out.totalParticipants, 2);
});

test('league: a name-lookup failure degrades to "Buddy"; a health failure still fails the league', async () => {
  reset();
  leagueMatch();
  state.namesFail = true;
  const out = await league.getConsistencyLeague(1);
  assert.ok(out.league.every((r) => r.name === 'Buddy'));
  state.namesFail = false;
  state.axiosFails = true;
  await assert.rejects(league.getConsistencyLeague(1), /Could not load consistency league/);
});
