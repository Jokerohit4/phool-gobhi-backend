// Buddy service core logic: swipes, matches, chat, blocks, match verification.
// Uses node:test + node:assert/strict with t.mock.module() for ESM mocking.
// Run with: node --experimental-test-module-mocks --test test/buddyService.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── In-memory stores ────────────────────────────────────────────────────────
const swipes = new Map();       // key: "swiperId-swipeeId"
const matches = new Map();      // key: match.id
const messages = new Map();     // key: message.id
const blocks = new Map();       // key: "blockerId-blockedId"
let nextId = 1;
function resetAll() {
  swipes.clear();
  matches.clear();
  messages.clear();
  blocks.clear();
  nextId = 1;
}

// ── Mock module setup (must run before importing buddyService) ──────────────
let recordSwipe, sendMessage, blockUser, unblockUser, unmatch, verifyActiveMatchMembership;

test('setup: mock all dependencies and import buddyService', async (t) => {
  resetAll();

  // -- @prisma/client -----------------------------------------------------------
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          // -- swipe --
          this.swipe = {
            upsert: async ({ where, create, update }) => {
              const key = `${create.swiperId}-${create.swipeeId}`;
              const existing = swipes.get(key);
              if (existing) { existing.action = update.action; return existing; }
              const row = { id: nextId++, ...create, createdAt: new Date() };
              swipes.set(key, row);
              return row;
            },
            findUnique: async ({ where }) => {
              const { swiperId_swipeeId } = where;
              if (swiperId_swipeeId) return swipes.get(`${swiperId_swipeeId.swiperId}-${swiperId_swipeeId.swipeeId}`) ?? null;
              return null;
            },
          };

          // -- match ---------------------------------------------------------------
          this.match = {
            create: async ({ data }) => {
              const id = nextId++;
              const row = { id, ...data, status: 'active', unmatchedBy: null, unmatchedAt: null, matchedAt: new Date() };
              matches.set(id, row);
              return row;
            },
            findUnique: async ({ where }) => {
              if (where.id != null) return matches.get(where.id) ?? null;
              if (where.userLowId_userHighId) {
                const { userLowId, userHighId } = where.userLowId_userHighId;
                for (const m of matches.values()) {
                  if (m.userLowId === userLowId && m.userHighId === userHighId) return m;
                }
                return null;
              }
              return null;
            },
            update: async ({ where, data }) => {
              const row = matches.get(where.id);
              if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
              Object.assign(row, data);
              return row;
            },
          };

          // -- chatMessage ---------------------------------------------------------
          this.chatMessage = {
            create: async ({ data }) => {
              const id = nextId++;
              const row = { id, ...data, createdAt: new Date(), readAt: null };
              messages.set(id, row);
              return row;
            },
          };

          // -- blockedUser ---------------------------------------------------------
          this.blockedUser = {
            upsert: async ({ where, create }) => {
              const key = `${create.blockerId}-${create.blockedId}`;
              const existing = blocks.get(key);
              if (existing) { if (create.reason) existing.reason = create.reason; return existing; }
              const row = { id: nextId++, ...create, createdAt: new Date() };
              blocks.set(key, row);
              return row;
            },
            findUnique: async ({ where }) => {
              const { blockerId_blockedId } = where;
              if (blockerId_blockedId) return blocks.get(`${blockerId_blockedId.blockerId}-${blockerId_blockedId.blockedId}`) ?? null;
              return null;
            },
            deleteMany: async ({ where }) => {
              let count = 0;
              if (where.blockerId !== undefined && where.blockedId !== undefined) {
                const key = `${where.blockerId}-${where.blockedId}`;
                if (blocks.delete(key)) count = 1;
              }
              return { count };
            },
            findMany: async ({ where }) => {
              const result = [];
              for (const [key, row] of blocks) {
                if (where.blockerId !== undefined && row.blockerId === where.blockerId) result.push(row);
              }
              return result;
            },
          };
        }
      },
      Prisma: {},
    },
  });

  // -- authClient (stubs) --
  t.mock.module('../services/authClient.js', {
    exports: {
      getUserInternal: async () => ({ id: 1, name: 'Test', fcmToken: null }),
      getUsersBatchInternal: async (ids) => ids.map((id) => ({ id, name: 'User', profileImageUrl: '' })),
    },
  });

  // -- notify (no-ops) --
  t.mock.module('../utils/notifyMatch.js', {
    exports: { notifyMatch: async () => {} },
  });
  t.mock.module('../utils/notifyMessage.js', {
    exports: { notifyMessage: async () => {} },
  });

  // -- analytics (no-op) --
  t.mock.module('../utils/analytics.js', {
    exports: { track: () => {} },
  });

  // -- geo (pass through) --
  t.mock.module('../utils/geo.js', {
    exports: {
      haversineKm: () => 1,
      boundingBox: () => ({ minLat: 0, maxLat: 90, minLng: -180, maxLng: 180 }),
      bucketDistanceKm: () => '< 1 km',
    },
  });

  // -- tier (pass through) --
  t.mock.module('../utils/tier.js', {
    exports: { assertTierAllows: () => {} },
  });

  // -- upload (pass through) --
  t.mock.module('../utils/upload.js', {
    exports: { MAX_BUDDY_PHOTOS: 6 },
  });

  // -- cloudinary (stub) --
  t.mock.module('../config/cloudinary.js', {
    exports: { default: { uploader: { upload: async () => ({ secure_url: '', public_id: '' }), destroy: async () => {} } } },
  });

  // Now import the service under test (picks up all mocks above).
  ({
    recordSwipe,
    sendMessage,
    blockUser,
    unblockUser,
    unmatch,
    verifyActiveMatchMembership,
  } = await import('../services/buddyService.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
// recordSwipe
// ─────────────────────────────────────────────────────────────────────────────

test('recordSwipe: self-swipe throws 400', async () => {
  resetAll();
  await assert.rejects(
    () => recordSwipe(1, 1, 'like'),
    (err) => { assert.equal(err.status, 400); return true; }
  );
});

test('recordSwipe: invalid action throws 400', async () => {
  resetAll();
  await assert.rejects(
    () => recordSwipe(1, 2, 'dislike'),
    (err) => { assert.equal(err.status, 400); return true; }
  );
});

test('recordSwipe: swiper blocked by swipee throws 403', async () => {
  resetAll();
  blocks.set('2-1', { id: nextId++, blockerId: 2, blockedId: 1, reason: null, createdAt: new Date() });
  await assert.rejects(
    () => recordSwipe(1, 2, 'like'),
    (err) => { assert.equal(err.status, 403); return true; }
  );
});

test('recordSwipe: swiper has blocked swipee throws 403', async () => {
  resetAll();
  blocks.set('1-2', { id: nextId++, blockerId: 1, blockedId: 2, reason: null, createdAt: new Date() });
  await assert.rejects(
    () => recordSwipe(1, 2, 'like'),
    (err) => { assert.equal(err.status, 403); return true; }
  );
});

test('recordSwipe: pass returns matched:false and no match is created', async () => {
  resetAll();
  const result = await recordSwipe(1, 2, 'pass');
  assert.deepEqual(result, { matched: false });
  assert.equal(matches.size, 0);
  assert.equal(swipes.get('1-2').action, 'pass');
});

test('recordSwipe: one-sided like returns matched:false', async () => {
  resetAll();
  const result = await recordSwipe(1, 2, 'like');
  assert.deepEqual(result, { matched: false });
  assert.equal(matches.size, 0);
  assert.equal(swipes.get('1-2').action, 'like');
});

test('recordSwipe: mutual like creates match', async () => {
  resetAll();
  // User 2 already liked user 1
  swipes.set('2-1', { id: nextId++, swiperId: 2, swipeeId: 1, action: 'like', createdAt: new Date() });

  const result = await recordSwipe(1, 2, 'like');
  assert.equal(result.matched, true);
  assert.ok(result.matchId);
  assert.equal(matches.size, 1);
  const match = matches.get(result.matchId);
  assert.equal(match.userLowId, 1);
  assert.equal(match.userHighId, 2);
  assert.equal(match.status, 'active');
});

test('recordSwipe: re-swipe (pass→like) upserts instead of erroring', async () => {
  resetAll();
  await recordSwipe(1, 2, 'pass');
  assert.equal(swipes.get('1-2').action, 'pass');

  const result = await recordSwipe(1, 2, 'like');
  assert.deepEqual(result, { matched: false });
  assert.equal(swipes.get('1-2').action, 'like');
  // Only one swipe row, not two
  assert.equal(swipes.size, 1);
});

test('recordSwipe: re-swiping same action is idempotent', async () => {
  resetAll();
  await recordSwipe(1, 2, 'like');
  await recordSwipe(1, 2, 'like');
  assert.equal(swipes.size, 1);
  assert.equal(swipes.get('1-2').action, 'like');
});

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage
// ─────────────────────────────────────────────────────────────────────────────

function makeActiveMatch(id, userA, userB) {
  const low = Math.min(userA, userB);
  const high = Math.max(userA, userB);
  matches.set(id, { id, userLowId: low, userHighId: high, status: 'active', unmatchedBy: null, unmatchedAt: null, matchedAt: new Date() });
}

test('sendMessage: empty body throws 400', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  await assert.rejects(
    () => sendMessage(10, 1, ''),
    (err) => { assert.equal(err.status, 400); return true; }
  );
});

test('sendMessage: whitespace-only body throws 400', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  await assert.rejects(
    () => sendMessage(10, 1, '   '),
    (err) => { assert.equal(err.status, 400); return true; }
  );
});

test('sendMessage: non-participant throws 403', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  await assert.rejects(
    () => sendMessage(99, 1, 'hello'),
    (err) => { assert.equal(err.status, 403); return true; }
  );
});

test('sendMessage: inactive match throws 409', async () => {
  resetAll();
  const low = Math.min(10, 20);
  const high = Math.max(10, 20);
  matches.set(1, { id: 1, userLowId: low, userHighId: high, status: 'unmatched', unmatchedBy: 10, unmatchedAt: new Date(), matchedAt: new Date() });
  await assert.rejects(
    () => sendMessage(10, 1, 'hello'),
    (err) => { assert.equal(err.status, 409); return true; }
  );
});

test('sendMessage: truncates body to 1000 chars', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  const longBody = 'x'.repeat(1500);
  const msg = await sendMessage(10, 1, longBody);
  assert.equal(msg.body.length, 1000);
  assert.equal(msg.body, 'x'.repeat(1000));
});

test('sendMessage: successful send returns message with correct fields', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  const msg = await sendMessage(10, 1, 'hey there');
  assert.equal(msg.senderId, 10);
  assert.equal(msg.matchId, 1);
  assert.equal(msg.body, 'hey there');
  assert.ok(msg.id);
  assert.ok(msg.createdAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// blockUser
// ─────────────────────────────────────────────────────────────────────────────

test('blockUser: self-block throws 400', async () => {
  resetAll();
  await assert.rejects(
    () => blockUser(1, 1, null),
    (err) => { assert.equal(err.status, 400); return true; }
  );
});

test('blockUser: creates block record', async () => {
  resetAll();
  const result = await blockUser(1, 2, 'spam');
  assert.equal(result.message, 'User blocked');
  const key = `${Math.min(1,2)}-${Math.max(1,2)}`;
  const b = blocks.get('1-2');
  assert.ok(b);
  assert.equal(b.blockerId, 1);
  assert.equal(b.blockedId, 2);
  assert.equal(b.reason, 'spam');
});

test('blockUser: auto-unmatches active match between blocker and blocked', async () => {
  resetAll();
  makeActiveMatch(1, 1, 2);
  await blockUser(1, 2, 'harassment');
  assert.equal(matches.get(1).status, 'unmatched');
  assert.equal(matches.get(1).unmatchedBy, 1);
});

test('blockUser: does not touch unrelated active matches', async () => {
  resetAll();
  makeActiveMatch(1, 1, 3);
  await blockUser(1, 2, null);
  assert.equal(matches.get(1).status, 'active');
});

test('blockUser: upsert is idempotent', async () => {
  resetAll();
  await blockUser(1, 2, 'first');
  await blockUser(1, 2, 'updated');
  const b = blocks.get('1-2');
  assert.equal(b.reason, 'updated');
  assert.equal(blocks.size, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// unblockUser
// ─────────────────────────────────────────────────────────────────────────────

test('unblockUser: removes the block record', async () => {
  resetAll();
  blocks.set('1-2', { id: nextId++, blockerId: 1, blockedId: 2, reason: null, createdAt: new Date() });
  const result = await unblockUser(1, 2);
  assert.equal(result.message, 'User unblocked');
  assert.equal(blocks.has('1-2'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// unmatch
// ─────────────────────────────────────────────────────────────────────────────

test('unmatch: sets active match to unmatched', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  const result = await unmatch(10, 1);
  assert.equal(result.status, 'unmatched');
  assert.equal(result.unmatchedBy, 10);
  assert.ok(result.unmatchedAt);
});

test('unmatch: non-participant throws 403', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  await assert.rejects(
    () => unmatch(99, 1),
    (err) => { assert.equal(err.status, 403); return true; }
  );
});

test('unmatch: idempotent on already-unmatched match (no error)', async () => {
  resetAll();
  const low = Math.min(10, 20);
  const high = Math.max(10, 20);
  matches.set(1, { id: 1, userLowId: low, userHighId: high, status: 'unmatched', unmatchedBy: 20, unmatchedAt: new Date(), matchedAt: new Date() });
  const result = await unmatch(10, 1);
  // Returns the existing match unchanged (no double-fire)
  assert.equal(result.status, 'unmatched');
  assert.equal(result.unmatchedBy, 20);
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyActiveMatchMembership
// ─────────────────────────────────────────────────────────────────────────────

test('verifyActiveMatchMembership: returns matched:true + otherUserId for active match (low member)', async () => {
  resetAll();
  makeActiveMatch(1, 5, 15);
  const result = await verifyActiveMatchMembership(1, 5);
  assert.deepEqual(result, { matched: true, otherUserId: 15 });
});

test('verifyActiveMatchMembership: returns matched:true + otherUserId for active match (high member)', async () => {
  resetAll();
  makeActiveMatch(1, 5, 15);
  const result = await verifyActiveMatchMembership(1, 15);
  assert.deepEqual(result, { matched: true, otherUserId: 5 });
});

test('verifyActiveMatchMembership: non-member returns matched:false', async () => {
  resetAll();
  makeActiveMatch(1, 5, 15);
  const result = await verifyActiveMatchMembership(1, 99);
  assert.deepEqual(result, { matched: false });
});

test('verifyActiveMatchMembership: unmatched match returns matched:false', async () => {
  resetAll();
  const low = Math.min(5, 15);
  const high = Math.max(5, 15);
  matches.set(1, { id: 1, userLowId: low, userHighId: high, status: 'unmatched', unmatchedBy: 5, unmatchedAt: new Date(), matchedAt: new Date() });
  const result = await verifyActiveMatchMembership(1, 5);
  assert.deepEqual(result, { matched: false });
});

test('verifyActiveMatchMembership: nonexistent match returns matched:false', async () => {
  resetAll();
  const result = await verifyActiveMatchMembership(999, 5);
  assert.deepEqual(result, { matched: false });
});
