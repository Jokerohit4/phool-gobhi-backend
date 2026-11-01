// Read caches on the hot paths (item 1: GET /discover candidate list + auth-service
// display names; item 2: chat-poll isActive lookup; item 3: feature-flag warm-up).
// The caches are OFF under `node --test` unless BUDDY_CACHE_FORCE=1, so each test
// that wants them on sets it explicitly.
// Run with: node --experimental-test-module-mocks --test test/feedAndChatCache.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

const tables = {
  buddyProfile: new Map(), buddyPhoto: new Map(), buddyFilter: new Map(),
  swipe: new Map(), match: new Map(), chatMessage: new Map(),
  blockedUser: new Map(), report: new Map(), buddyFollow: new Map(),
};
const fake = createFakePrisma(tables);

// Count every DB call (one level deep: fake.<model>.<method>).
let dbCalls = 0;
for (const model of Object.values(fake)) {
  if (!model || typeof model !== 'object') continue;
  for (const [name, fn] of Object.entries(model)) {
    if (typeof fn === 'function') model[name] = (...a) => { dbCalls++; return fn(...a); };
  }
}
let failNextSwipeRead = false;
const origSwipeFindMany = fake.swipe.findMany;
fake.swipe.findMany = async (...a) => {
  if (failNextSwipeRead) { failNextSwipeRead = false; dbCalls++; throw new Error('db blip'); }
  return origSwipeFindMany(...a);
};

let nameCalls = [];
mock.module('@prisma/client', { exports: { PrismaClient: class { constructor() { return fake; } }, Prisma: {} } });
mock.module('../services/authClient.js', {
  exports: {
    getUserInternal: async (id) => ({ id }),
    getUsersBatchInternal: async (ids) => { nameCalls.push([...ids]); return ids.map((id) => ({ id, name: `P${id}`, profileImageUrl: '' })); },
  },
});
mock.module('../utils/analytics.js', { exports: { track: () => {} } });
mock.module('../utils/notifyMatch.js', { exports: { notifyMatch: async () => {} } });
mock.module('../utils/notifyMessage.js', { exports: { notifyMessage: async () => {} } });
mock.module('../utils/tier.js', { exports: { assertTierAllows: () => {} } });
mock.module('../utils/upload.js', { exports: { MAX_BUDDY_PHOTOS: 6 } });
mock.module('../config/cloudinary.js', { exports: { default: { uploader: { destroy: async () => {} } } } });

const svc = await import('../services/buddyService.js');
const erasure = await import('../services/erasureService.js');
const { feedCache, activeCache } = await import('../utils/buddyCaches.js');

const BASE = { lat: 28.46, lng: 77.03 };
const kmNorth = (km) => ({ lat: BASE.lat + km / 111, lng: BASE.lng });
let seq = 1;

function reset() {
  for (const t of Object.values(tables)) t.clear();
  feedCache.clear(); activeCache.clear();
  nameCalls = []; dbCalls = 0; failNextSwipeRead = false; seq = 1;
  delete process.env.BUDDY_CACHE_FORCE;
}
function seedUser(userId, km = 0, over = {}) {
  const id = 1000 + userId;
  tables.buddyProfile.set(id, {
    id, userId, bio: `bio${userId}`, socialMediaUrl: null, gender: 'male',
    dateOfBirth: new Date(new Date().getFullYear() - 28, 0, 1), fitnessGoals: [], lastSyncedAt: null,
    ...kmNorth(km), isDiscoverable: true, isActive: true, createdAt: new Date('2026-01-01'),
    updatedAt: new Date(), moderationHoldAt: null, genderChangedAt: null, genderChangedTo: null,
    genderChangeClearedAt: null, womenOnlyBlocked: false, ...over,
  });
  for (let i = 0; i < 3; i++) {
    const pid = id * 10 + i;
    tables.buddyPhoto.set(pid, { id: pid, buddyProfileId: id, url: `u/${userId}/${i}`, publicId: null, order: i, createdAt: new Date() });
  }
}
function fixture() {
  seedUser(1, 0);
  for (let u = 2; u <= 6; u++) seedUser(u, u); // 2..6 at 2..6 km
}
const ids = (r) => r.data.map((c) => c.userId);

test('output is identical cached vs uncached, pages 1 and 2', async () => {
  reset(); fixture();
  const off1 = await svc.getFeed(1, { page: 1, limit: 2 });
  const off2 = await svc.getFeed(1, { page: 2, limit: 2 });
  feedCache.clear();
  process.env.BUDDY_CACHE_FORCE = '1';
  const on1 = await svc.getFeed(1, { page: 1, limit: 2 });
  const on2 = await svc.getFeed(1, { page: 2, limit: 2 });
  assert.deepEqual(on1, off1);
  assert.deepEqual(on2, off2);
  assert.deepEqual(ids(on1), [2, 3]);
  assert.deepEqual(ids(on2), [4, 5]);
  assert.equal(on1.hasMore, true);
});

test('page 2 is served with zero DB calls (only the page names are fetched)', async () => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  await svc.getFeed(1, { page: 1, limit: 2 });
  const before = dbCalls;
  nameCalls = [];
  const p2 = await svc.getFeed(1, { page: 2, limit: 2 });
  assert.equal(dbCalls, before, 'no DB query on page 2');
  assert.deepEqual(nameCalls, [[4, 5]]);
  assert.deepEqual(ids(p2), [4, 5]);
});

test('cache is off by default under node --test', async () => {
  reset(); fixture();
  await svc.getFeed(1, { page: 1, limit: 2 });
  const before = dbCalls;
  await svc.getFeed(1, { page: 2, limit: 2 });
  assert.ok(dbCalls > before);
});

test('TTL expiry: a deck older than 45s is rebuilt', async (t) => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  let now = 5_000_000;
  t.mock.method(Date, 'now', () => now);
  await svc.getFeed(1, { page: 1, limit: 2 });
  let before = dbCalls;
  now += 44_000;
  await svc.getFeed(1, { page: 2, limit: 2 });
  assert.equal(dbCalls, before);
  now += 2_000;
  await svc.getFeed(1, { page: 2, limit: 2 });
  assert.ok(dbCalls > before);
});

test('a failed build is never cached', async () => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  failNextSwipeRead = true;
  await assert.rejects(svc.getFeed(1, { page: 1, limit: 2 }), /db blip/);
  const ok = await svc.getFeed(1, { page: 1, limit: 2 });
  assert.deepEqual(ids(ok), [2, 3]);
});

test('own swipe evicts immediately: the swiped user never reappears', async () => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  assert.deepEqual(ids(await svc.getFeed(1, { page: 1, limit: 2 })), [2, 3]);
  await svc.recordSwipe(1, 2, 'pass');
  assert.deepEqual(ids(await svc.getFeed(1, { page: 1, limit: 2 })), [3, 4]);
  assert.deepEqual(ids(await svc.getFeed(1, { page: 2, limit: 2 })), [5, 6]);
});

test('own block evicts both decks; a block against me evicts mine', async () => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  await svc.getFeed(1, { page: 1, limit: 5 });
  await svc.getFeed(3, { page: 1, limit: 5 });
  await svc.blockUser(1, 3);
  assert.ok(!ids(await svc.getFeed(1, { page: 1, limit: 5 })).includes(3));
  assert.ok(!ids(await svc.getFeed(3, { page: 1, limit: 5 })).includes(1));
  // user 4 blocks viewer 1: viewer 1's cached deck must drop 4
  await svc.getFeed(1, { page: 1, limit: 5 });
  await svc.blockUser(4, 1);
  assert.ok(!ids(await svc.getFeed(1, { page: 1, limit: 5 })).includes(4));
});

test('report evicts both directions', async () => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  await svc.getFeed(1, { page: 1, limit: 5 });
  await svc.getFeed(2, { page: 1, limit: 5 });
  await svc.reportUser(1, 2, 'harassment', 'x');
  assert.ok(!ids(await svc.getFeed(1, { page: 1, limit: 5 })).includes(2));
  assert.ok(!ids(await svc.getFeed(2, { page: 1, limit: 5 })).includes(1));
});

test("another user's profile edit and erasure drop every cached deck", async () => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  await svc.getFeed(1, { page: 1, limit: 5 });
  await svc.createOrUpdateProfile(2, { isDiscoverable: false });
  assert.ok(!ids(await svc.getFeed(1, { page: 1, limit: 5 })).includes(2));
  // the shared fake has no `records` relation: strip it for the erasure call only
  const fu = fake.buddyProfile.findUnique;
  fake.buddyProfile.findUnique = async (args) => {
    if (!args.include?.records) return fu(args);
    const { records, ...include } = args.include;
    const r = await fu({ ...args, include });
    return r && { ...r, records: [] };
  };
  try { await erasure.eraseUserService(3); } finally { fake.buddyProfile.findUnique = fu; }
  assert.ok(!ids(await svc.getFeed(1, { page: 1, limit: 5 })).includes(3));
});

test('own suspension/hold are re-checked on the next cold build (reinstate evicts)', async () => {
  reset(); fixture(); process.env.BUDDY_CACHE_FORCE = '1';
  await svc.getFeed(1, { page: 1, limit: 5 });
  tables.report.set(1, { id: 1, reporterId: 2, reportedUserId: 1, reason: 'x', status: 'open', severity: 'normal', createdAt: new Date() });
  await svc.reviewReport(1, { status: 'actioned', suspend: true }, 9);
  await assert.rejects(svc.getFeed(1, { page: 1, limit: 5 }), (e) => e.code === 'BUDDY_SUSPENDED');
  await svc.reinstateUser(1);
  assert.ok(ids(await svc.getFeed(1, { page: 1, limit: 5 })).length > 0);
});

// ---- Item 2: chat poll ---------------------------------------------------------

function chat() {
  seedUser(1); seedUser(2);
  tables.match.set(5, { id: 5, userLowId: 1, userHighId: 2, status: 'active', unmatchedBy: null, unmatchedAt: null, matchedAt: new Date(), lastActivityAt: new Date() });
  tables.chatMessage.set(9, { id: 9, matchId: 5, senderId: 2, body: 'hi', createdAt: new Date() });
}
const profileReads = () => {
  let n = 0;
  const f = fake.buddyProfile.findUnique;
  fake.buddyProfile.findUnique = (...a) => { n++; return f(...a); };
  return { count: () => n, restore: () => { fake.buddyProfile.findUnique = f; } };
};

test('chat poll: the isActive lookup is cached for 30s', async () => {
  reset(); chat(); process.env.BUDDY_CACHE_FORCE = '1';
  await svc.getMessages(1, 5, { after: '0' });
  const spy = profileReads();
  await svc.getMessages(1, 5, { after: '0' });
  await svc.getMessages(1, 5, { after: '0' });
  assert.equal(spy.count(), 0);
  spy.restore();
});

test('chat poll: a block right after a cached poll fails the next poll', async () => {
  reset(); chat(); process.env.BUDDY_CACHE_FORCE = '1';
  assert.equal((await svc.getMessages(1, 5, { after: '0' })).length, 1);
  await svc.blockUser(2, 1);
  await assert.rejects(svc.getMessages(1, 5, { after: '0' }), (e) => e.status === 410);
});

test('chat poll: an unmatch right after a cached poll fails the next poll', async () => {
  reset(); chat(); process.env.BUDDY_CACHE_FORCE = '1';
  await svc.getMessages(1, 5, { after: '0' });
  await svc.unmatch(2, 5);
  await assert.rejects(svc.getMessages(1, 5, { after: '0' }), (e) => e.status === 410);
});

test('chat poll: suspension then reinstatement is seen immediately', async () => {
  reset(); chat(); process.env.BUDDY_CACHE_FORCE = '1';
  tables.buddyProfile.get(1002).isActive = false; // suspended before any poll
  await assert.rejects(svc.getMessages(1, 5, { after: '0' }), (e) => e.status === 410);
  await svc.reinstateUser(2); // evicts user 2's cached flag
  assert.equal((await svc.getMessages(1, 5, { after: '0' })).length, 1);
});

// ---- Item 3: warm flags -----------------------------------------------------------

test('feature flags: warmed at load outside node --test only; never throws', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('down'); });
  t.mock.method(console, 'error', () => {});
  await import('../middleware/requireFeatureFlag.js?warm=default');
  assert.equal(calls, 0, 'no warm-up under node --test');
  process.env.BUDDY_FLAG_WARM_FORCE = '1';
  try {
    await import('../middleware/requireFeatureFlag.js?warm=forced'); // must not reject
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1, 'warm-up fetched flags once');
  } finally {
    delete process.env.BUDDY_FLAG_WARM_FORCE;
  }
});

test('feature flags: a request after warm-up does not refetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true, json: async () => ({ features: { buddy: { enabled: true } } }) }; });
  process.env.BUDDY_FLAG_WARM_FORCE = '1';
  try {
    const mod = await import('../middleware/requireFeatureFlag.js?warm=hit');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await mod.isFeatureEnabled('buddy'), true);
    assert.equal(calls, 1);
  } finally {
    delete process.env.BUDDY_FLAG_WARM_FORCE;
  }
});
