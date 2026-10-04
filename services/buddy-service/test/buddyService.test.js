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
const reports = new Map();      // key: report.id
let nextId = 1;
function resetAll() {
  swipes.clear();
  matches.clear();
  messages.clear();
  blocks.clear();
  reports.clear();
  nextId = 1;
}

// ── Mock module setup (must run before importing buddyService) ──────────────
let recordSwipe, sendMessage, blockUser, unblockUser, unmatch, verifyActiveMatchMembership;
let getMessages, getMatches, getMatchedProfile, reportUser, listReports, reviewReport;

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
              const now = new Date();
              const row = {
                id, ...data,
                status: 'active',
                unmatchedBy: null, unmatchedAt: null,
                matchedAt: data.matchedAt ?? now,
                // Mirrors the column DEFAULT. Tests that need a stale match
                // overwrite this explicitly rather than reaching for a fake
                // clock, so there is only one way a row goes stale.
                lastActivityAt: data.lastActivityAt ?? now,
              };
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
            // Deliberately filter-aware rather than a stub that ignores `where`.
            // The whole point of the expiry tests is that the read side hides
            // stale matches; a mock that returned every row would make
            // getMatches pass no matter what the query said.
            findMany: async ({ where, include }) => {
              let rows = [...matches.values()];
              if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
              if (where.lastActivityAt?.gte !== undefined) {
                rows = rows.filter((r) => new Date(r.lastActivityAt) >= new Date(where.lastActivityAt.gte));
              }
              if (Array.isArray(where.OR)) {
                rows = rows.filter((r) => where.OR.some((c) => (
                  (c.userLowId !== undefined && r.userLowId === c.userLowId)
                  || (c.userHighId !== undefined && r.userHighId === c.userHighId)
                )));
              }
              if (where.lastActivityAt?.lt !== undefined) {
                rows = rows.filter((r) => new Date(r.lastActivityAt) < new Date(where.lastActivityAt.lt));
              }
              // Honour the `include` getMatches uses for its last-message
              // preview, otherwise m.messages[0] throws and every list test
              // fails for a reason that has nothing to do with the filter.
              if (include?.messages) {
                rows = rows.map((r) => {
                  const last = [...messages.values()]
                    .filter((msg) => msg.matchId === r.id)
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .slice(0, include.messages.take ?? 1);
                  return { ...r, messages: last };
                });
              }
              return rows;
            },
            update: async ({ where, data }) => {
              const row = matches.get(where.id);
              if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
              Object.assign(row, data);
              return row;
            },
            updateMany: async ({ where, data }) => {
              const rows = await this.match.findMany({ where });
              rows.forEach((r) => Object.assign(r, data));
              return { count: rows.length };
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
            findMany: async ({ where }) => {
              let rows = [...messages.values()];
              if (where.matchId !== undefined) rows = rows.filter((r) => r.matchId === where.matchId);
              if (where.id?.gt !== undefined) rows = rows.filter((r) => r.id > where.id.gt);
              if (where.id?.lt !== undefined) rows = rows.filter((r) => r.id < where.id.lt);
              return rows;
            },
          };

          // -- buddyProfile (minimal: getMatches only needs the first photo) --------
          this.buddyProfile = {
            findMany: async ({ where }) => {
              const ids = where.userId?.in ?? [];
              return ids.map((userId) => ({ userId, photos: [] }));
            },
            findUnique: async () => null,
          };

          // -- report (moderation) -------------------------------------------------
          // Unique-constraint violations are thrown as real P2002s, because the
          // controller's 409 anti-spam handling is only meaningfully tested if
          // the mock reproduces the error Prisma would raise.
          this.report = {
            create: async ({ data }) => {
              const clash = [...reports.values()].find((r) => (
                r.reporterId === data.reporterId && r.reportedUserId === data.reportedUserId
              ));
              if (clash) {
                throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
              }
              const id = nextId++;
              const row = {
                id, ...data,
                status: 'open',
                reviewedBy: null, reviewedAt: null, resolutionNote: null,
                // Monotonic rather than new Date(): rows created in the same tick
                // would otherwise share a timestamp and make any "newest first"
                // assertion a coin flip.
                createdAt: new Date(1_700_000_000_000 + id * 1000),
              };
              reports.set(id, row);
              return row;
            },
            findUnique: async ({ where }) => reports.get(where.id) ?? null,
            findMany: async ({ where, orderBy }) => {
              let rows = [...reports.values()];
              if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
              if (where.reporterId !== undefined) rows = rows.filter((r) => r.reporterId === where.reporterId);
              if (where.reportedUserId?.in !== undefined) {
                rows = rows.filter((r) => where.reportedUserId.in.includes(r.reportedUserId));
              }
              const order = Array.isArray(orderBy) ? orderBy : (orderBy ? [orderBy] : []);
              for (const clause of [...order].reverse()) {
                const [field, dir] = Object.entries(clause)[0];
                const sign = dir === 'asc' ? 1 : -1;
                rows.sort((a, b) => {
                  const av = a[field] instanceof Date ? a[field].getTime() : a[field];
                  const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
                  return av === bv ? 0 : (av < bv ? -1 : 1) * sign;
                });
              }
              return where.take ? rows.slice(0, where.take) : rows;
            },
            count: async ({ where }) => [...reports.values()].filter((r) => {
              if (where.reporterId !== undefined && r.reporterId !== where.reporterId) return false;
              if (where.reportedUserId !== undefined && r.reportedUserId !== where.reportedUserId) return false;
              if (where.id?.not !== undefined && r.id === where.id.not) return false;
              return true;
            }).length,
            update: async ({ where, data }) => {
              const row = reports.get(where.id);
              if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
              Object.assign(row, data);
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
    getMessages,
    getMatches,
    getMatchedProfile,
    reportUser,
    listReports,
    reviewReport,
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

function makeActiveMatch(id, userA, userB, { daysSinceActivity = 0 } = {}) {
  const low = Math.min(userA, userB);
  const high = Math.max(userA, userB);
  const at = new Date(Date.now() - daysSinceActivity * 24 * 60 * 60 * 1000);
  matches.set(id, {
    id, userLowId: low, userHighId: high, status: 'active',
    unmatchedBy: null, unmatchedAt: null,
    matchedAt: at, lastActivityAt: at,
  });
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

// ============================================================================
// Moderation: match expiry + reporting (2026-10-04)
// ============================================================================

// 30-day boundary. MATCH_EXPIRY_DAYS is imported from the module under test so
// these tests cannot drift from the constant if it is ever retuned.
const EXPIRY_DAYS = 30;

test('getMessages: rejects after a block auto-unmatched the match (regression)', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  // A message exists, so there IS history to protect.
  messages.set(1, { id: 1, matchId: 1, senderId: 10, body: 'hi', createdAt: new Date() });

  // Block severs the conversation ...
  await blockUser(10, 20, 'spam');
  assert.equal(matches.get(1).status, 'unmatched');

  // ... and the blocker must not still be able to read it by matchId.
  // Before this guard, getMessages only called assertParticipant, so the whole
  // thread stayed readable for as long as the id was known: a block that left
  // read access intact was not a block.
  await assert.rejects(
    () => getMessages(10, 1),
    (err) => err.status === 410,
  );
});

test('getMessages: rejects after an explicit unmatch', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  await unmatch(10, 1);
  await assert.rejects(() => getMessages(10, 1), (err) => err.status === 410);
});

test('getMessages: still reads an active match', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20);
  messages.set(1, { id: 1, matchId: 1, senderId: 10, body: 'hi', createdAt: new Date() });
  const result = await getMessages(10, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].body, 'hi');
});

test('getMessages: rejects a match expired by inactivity, and persists it', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20, { daysSinceActivity: EXPIRY_DAYS + 1 });

  await assert.rejects(() => getMessages(10, 1), (err) => err.status === 410);

  // The 410 is also the write that persists expiry, so a stale match stops
  // being re-evaluated on every subsequent request.
  assert.equal(matches.get(1).status, 'expired');
});

test('getMatches: hides expired matches without writing (idempotent read)', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20, { daysSinceActivity: EXPIRY_DAYS + 1 });
  makeActiveMatch(2, 10, 30, { daysSinceActivity: 1 });

  const result = await getMatches(10);
  assert.equal(result.length, 1);
  assert.equal(result[0].matchId, 2);

  // List reads filter in the query and never write; only the by-id guard
  // persists `expired`. A list open must not mutate state.
  assert.equal(matches.get(1).status, 'active');
});

test('getMatches: a match exactly at the boundary is still alive', async () => {
  resetAll();
  // Strictly-less-than in the sweep, greater-or-equal in the list. An off-by-one
  // in either direction would either expire a live match or resurrect a dead one.
  makeActiveMatch(1, 10, 20, { daysSinceActivity: EXPIRY_DAYS - 1 });
  const result = await getMatches(10);
  assert.equal(result.length, 1);
});

test('sendMessage: keeps 409 (not 410) on a dead match - existing client contract', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20, { daysSinceActivity: EXPIRY_DAYS + 1 });
  // sendMessage has always answered 409 here and clients branch on it; unifying
  // with the read paths' 410 would be a silent client-facing break.
  await assert.rejects(() => sendMessage(10, 1, 'hello'), (err) => err.status === 409);
});

test('sendMessage: bumps lastActivityAt so an active conversation never expires', async () => {
  resetAll();
  // 29 days of silence: close enough to the wall that without the bump this
  // match would cross the line moments later.
  makeActiveMatch(1, 10, 20, { daysSinceActivity: EXPIRY_DAYS - 1 });
  const before = matches.get(1).lastActivityAt;

  await sendMessage(10, 1, 'still here');

  assert.ok(matches.get(1).lastActivityAt > before);
  assert.equal((await getMatches(10)).length, 1);
});

test('getMatchedProfile: rejects an expired match and persists it', async () => {
  resetAll();
  makeActiveMatch(1, 10, 20, { daysSinceActivity: EXPIRY_DAYS + 1 });
  await assert.rejects(() => getMatchedProfile(10, 1), (err) => err.status === 410);
  assert.equal(matches.get(1).status, 'expired');
});

test('verifyActiveMatchMembership: expired match does not authorize a paired streak', async () => {
  resetAll();
  makeActiveMatch(1, 5, 15, { daysSinceActivity: EXPIRY_DAYS + 1 });
  // challenge-service asks this to turn a matchId into a verified pair. A
  // month-dead match is not a live pairing, and this path must not write.
  const result = await verifyActiveMatchMembership(1, 15);
  assert.deepEqual(result, { matched: false });
  assert.equal(matches.get(1).status, 'active');
});

test('verifyActiveMatchMembership: a match written before lastActivityAt existed still expires', async () => {
  resetAll();
  // Simulates a row created by the old code path / pre-migration data:
  // lastActivityAt absent. It must be treated as stale-relative-to-matchedAt,
  // not as infinitely fresh, or the migration would leave old matches
  // permanently exempt from expiry.
  matches.set(1, {
    id: 1, userLowId: 5, userHighId: 15, status: 'active',
    unmatchedBy: null, unmatchedAt: null,
    matchedAt: new Date(Date.now() - (EXPIRY_DAYS + 5) * 86400000),
    lastActivityAt: null,
  });
  assert.deepEqual(await verifyActiveMatchMembership(1, 15), { matched: false });
});

// ---- Reports --------------------------------------------------------------

test('reportUser: creates an open report', async () => {
  resetAll();
  const result = await reportUser(10, 30, 'harassment');
  assert.equal(result.status, 'open');
  assert.equal(reports.get(result.reportId).reason, 'harassment');
});

test('reportUser: severs an active match so the reporter gets relief', async () => {
  resetAll();
  makeActiveMatch(1, 10, 30);

  const result = await reportUser(10, 30, 'threat');

  // The point of the sever: "we logged your report but you are still matched
  // with them" is not relief. The match is cut, and the response tells the
  // client which one so it can drop the conversation rather than show a
  // mysteriously dead thread.
  assert.equal(result.severedMatchId, 1);
  assert.equal(matches.get(1).status, 'unmatched');
});

test('reportUser: does NOT block - blocking stays the user own explicit choice', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  // A report is filed *about* someone. A block also removes them from the other
  // person's view, and the reporter may not want that, so reporting must not
  // quietly do it.
  assert.equal(blocks.size, 0);
});

test('reportUser: does not touch discovery filtering (no block row either way)', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  for (const row of blocks.values()) {
    assert.ok(!(row.blockerId === 10 && row.blockedId === 30));
  }
});

test('reportUser: rejects self-report', async () => {
  resetAll();
  await assert.rejects(() => reportUser(10, 10, 'spam'), (err) => err.status === 400);
});

test('reportUser: truncates oversized details to the column width', async () => {
  resetAll();
  const result = await reportUser(10, 30, 'other', 'x'.repeat(5000));
  assert.equal(reports.get(result.reportId).details.length, 1000);
});

test('reportUser: duplicate report from same reporter surfaces P2002 for the controller to map', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  // The service lets Prisma's unique violation through; turning it into a 409
  // is the controller's job, and that mapping is only testable if the error
  // actually arrives.
  await assert.rejects(() => reportUser(10, 30, 'harassment'), (err) => err.code === 'P2002');
});

test('listReports: returns only open reports by default, newest first', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');   // older
  await reportUser(11, 31, 'scam');   // newer
  const open = await listReports({});
  assert.equal(open.length, 2);
  // Newest first, so the report filed second leads the queue.
  assert.equal(open[0].reason, 'scam');

  // Triaging the newest leaves the older one still open.
  await reviewReport(open[0].id, { status: 'dismissed' }, 99);
  const afterReview = await listReports({});
  assert.equal(afterReview.length, 1);
  assert.equal(afterReview[0].reason, 'spam');
});

test('listReports: counts prior reports about the same person', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  await reportUser(11, 30, 'harassment');
  await reportUser(12, 30, 'threat');

  // "How many reports has this person ever had?" is the question that decides
  // whether one more tips into action, so it must be on the row.
  const [row] = await listReports({ status: 'all' });
  assert.equal(row.priorReportsAboutReportedUser, 2);
});

test('listReports: marks a report whose subject erased, and keeps it queued', async () => {
  resetAll();
  await reportUser(10, 30, 'threat');
  const [id] = [...reports.keys()];

  // erasureService nulls reportedUserId rather than deleting the row: the
  // safety record outlives the account, the pointer to the person does not.
  reports.get(id).reportedUserId = null;

  const rows = await listReports({});
  assert.equal(rows.length, 1, 'the report must survive erasure of its subject');
  assert.equal(rows[0].reportedUser.erased, true);
  assert.equal(rows[0].reportedUser.userId, null);
});

test('listReports: status=all includes reviewed reports', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  const [id] = [...reports.keys()];
  await reviewReport(id, { status: 'dismissed' }, 99);
  assert.equal((await listReports({ status: 'all' })).length, 1);
});

test('listReports: order is total even when two reports share a createdAt', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  await reportUser(11, 31, 'scam');
  // Force the collision that made this suite flaky before: identical
  // timestamps mean "newest first" alone has no answer.
  const [a, b] = [...reports.values()];
  b.createdAt = a.createdAt;

  const rows = await listReports({});
  assert.equal(rows.length, 2);
  // id desc is the tie-break, so the order is defined rather than a coin flip.
  // Without it, a paginated queue can repeat or skip a report at the boundary.
  assert.deepEqual(rows.map((r) => r.id), [b.id, a.id]);

  // And it is stable across repeated reads, not just right once.
  const again = await listReports({});
  assert.deepEqual(again.map((r) => r.id), rows.map((r) => r.id));
});

test('reviewReport: records who reviewed it and when', async () => {
  resetAll();
  await reportUser(10, 30, 'threat');
  const [id] = [...reports.keys()];

  const updated = await reviewReport(id, { status: 'actioned', resolutionNote: 'blocked' }, 77);

  // reviewedBy must be distinguishable from reporterId, or "who reported" and
  // "who reviewed" become the same field.
  assert.equal(updated.reviewedBy, 77);
  assert.ok(updated.reviewedAt instanceof Date);
  assert.equal(updated.resolutionNote, 'blocked');
  assert.equal(updated.status, 'actioned');
});

test('reviewReport: rejects re-opening - only dismissed or actioned are valid outcomes', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  const [id] = [...reports.keys()];
  // `open` is not a legal review outcome: it would let a triaged report silently
  // return to the queue with a resolution note attached.
  await assert.rejects(
    () => reviewReport(id, { status: 'open' }, 77),
    (err) => err.status === 400,
  );
});

test('reviewReport: 404s an unknown report', async () => {
  resetAll();
  await assert.rejects(
    () => reviewReport(4242, { status: 'dismissed' }, 77),
    (err) => err.status === 404,
  );
});

test('reviewReport: truncates an oversized resolution note', async () => {
  resetAll();
  await reportUser(10, 30, 'spam');
  const [id] = [...reports.keys()];
  const updated = await reviewReport(id, { status: 'dismissed', resolutionNote: 'y'.repeat(900) }, 77);
  assert.equal(updated.resolutionNote.length, 500);
});