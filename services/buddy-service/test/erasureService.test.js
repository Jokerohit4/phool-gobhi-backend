// DPDPA erasure of the moderation layer (buddy-service).
//
// Focused on the Report handling added 2026-10-04, which is the only erasure
// path in this service whose correct behaviour is *asymmetric* - everything else
// here deletes both directions, so a change that quietly made reports symmetric
// would pass every other test in this file and still be a DPDPA problem.
//
// Run with: node --experimental-test-module-mocks --test test/erasureService.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ME = 10;
const THEM = 30;

const matches = new Map();
const messages = new Map();
const swipes = new Map();
const blocks = new Map();
const reports = new Map();
const profiles = new Map();
const photos = new Map();
const filters = new Map();
let nextId = 1;

function resetAll() {
  matches.clear(); messages.clear(); swipes.clear(); blocks.clear();
  reports.clear(); profiles.clear(); photos.clear(); filters.clear();
  nextId = 1;
}

// A match + message pair the eraser participates in, so the transaction has
// something real to cascade over.
function seedMatch(userA, userB) {
  const low = Math.min(userA, userB);
  const high = Math.max(userA, userB);
  const id = nextId++;
  matches.set(id, { id, userLowId: low, userHighId: high, status: 'active' });
  const msgId = nextId++;
  messages.set(msgId, { id: msgId, matchId: id, senderId: userA, body: 'hi' });
  return id;
}

function seedReport({ reporterId, reportedUserId, reason = 'spam' }) {
  const id = nextId++;
  reports.set(id, {
    id, reporterId, reportedUserId, reason,
    details: null, status: 'open',
    reviewedBy: null, reviewedAt: null, resolutionNote: null,
    createdAt: new Date(),
  });
  return id;
}

let eraseUserService;

test('setup: mock prisma + cloudinary, import erasureService', async (t) => {
  resetAll();

  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.chatMessage = {
            deleteMany: async ({ where }) => {
              const hit = (m) => where.matchId?.in?.includes(m.matchId)
                || where.senderId === m.senderId;
              let count = 0;
              for (const [k, m] of messages) if (hit(m)) { messages.delete(k); count += 1; }
              return { count };
            },
          };
          this.match = {
            findMany: async ({ where }) => [...matches.values()].filter((m) => (
              where.OR.some((c) => c.userLowId === m.userLowId || c.userHighId === m.userHighId)
            )).map((m) => ({ id: m.id })),
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [k, m] of matches) {
                if (where.OR.some((c) => c.userLowId === m.userLowId || c.userHighId === m.userHighId)) {
                  matches.delete(k); count += 1;
                }
              }
              return { count };
            },
          };
          this.swipe = {
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [k, s] of swipes) {
                if (where.OR.some((c) => c.swiperId === s.swiperId || c.swipeeId === s.swipeeId)) {
                  swipes.delete(k); count += 1;
                }
              }
              return { count };
            },
          };
          this.blockedUser = {
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [k, b] of blocks) {
                if (where.OR.some((c) => c.blockerId === b.blockerId || c.blockedId === b.blockedId)) {
                  blocks.delete(k); count += 1;
                }
              }
              return { count };
            },
          };

          // -- the two report paths, which must NOT behave alike -------------
          this.report = {
            // As reporter: the user's own assertion, deleted outright.
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [k, r] of reports) {
                if (where.reporterId === r.reporterId) { reports.delete(k); count += 1; }
              }
              return { count };
            },
            // As reported subject: row kept, pointer dropped.
            updateMany: async ({ where, data }) => {
              let count = 0;
              for (const r of reports.values()) {
                if (where.reportedUserId === r.reportedUserId) {
                  Object.assign(r, data); count += 1;
                }
              }
              return { count };
            },
          };

          this.buddyFilter = {
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [k, f] of filters) if (f.userId === where.userId) { filters.delete(k); count += 1; }
              return { count };
            },
          };
          this.buddyPhoto = {
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [k, p] of photos) {
                if (p.buddyProfileId === where.buddyProfileId) { photos.delete(k); count += 1; }
              }
              return { count };
            },
          };
          this.buddyProfile = {
            findUnique: async ({ where }) => profiles.get(where.userId) ?? null,
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [k, p] of profiles) if (p.userId === where.userId) { profiles.delete(k); count += 1; }
              return { count };
            },
          };

          // Prisma's $transaction array form runs every op in one transaction;
          // the mock just executes them in order, which is enough to observe
          // the resulting state.
          this.$transaction = async (ops) => {
            const out = [];
            for (const op of ops) out.push(await op);
            return out;
          };
        }
      },
      Prisma: {},
    },
  });

  t.mock.module('../config/cloudinary.js', {
    exports: { default: { uploader: { destroy: async () => {} } } },
  });

  ({ eraseUserService } = await import('../services/erasureService.js'));
  assert.equal(typeof eraseUserService, 'function');
});

test('erasure deletes reports the user filed', async () => {
  resetAll();
  const id = seedReport({ reporterId: ME, reportedUserId: THEM });

  await eraseUserService(ME);

  // The report is the user's own account of events. There is no safety claim
  // that outranks a person's right to withdraw it.
  assert.equal(reports.has(id), false);
});

test('erasure KEEPS reports about the user, dropping only the pointer to them', async () => {
  resetAll();
  const id = seedReport({ reporterId: THEM, reportedUserId: ME, reason: 'harassment' });

  await eraseUserService(ME);

  // The asymmetry, and the whole reason this test exists. Deleting the row would
  // make account deletion a way to erase accountability: the moderation history
  // for that person would silently vanish from the queue. Keeping the id would
  // retain the personal data we were asked to erase. So the report survives and
  // the pointer does not.
  assert.equal(reports.has(id), true, 'the safety record must survive');
  assert.equal(reports.get(id).reportedUserId, null, 'the pointer to the erased user must go');
  // Everything else about the report is untouched, so it stays reviewable.
  assert.equal(reports.get(id).reason, 'harassment');
  assert.equal(reports.get(id).status, 'open');
  assert.equal(reports.get(id).reporterId, THEM);
});

test('erasure handles both roles in one pass without cross-contaminating', async () => {
  resetAll();
  const mineAsReporter = seedReport({ reporterId: ME, reportedUserId: 31 });
  const mineAsSubject = seedReport({ reporterId: 32, reportedUserId: ME });
  const unrelated = seedReport({ reporterId: 40, reportedUserId: 41 });

  await eraseUserService(ME);

  assert.equal(reports.has(mineAsReporter), false, 'filed by them: deleted');
  assert.equal(reports.has(mineAsSubject), true, 'filed about them: kept');
  assert.equal(reports.get(mineAsSubject).reportedUserId, null);

  // A report with no connection to the erased user must not be touched - not
  // deleted, not nulled. A sloppy `where` clause here would quietly destroy
  // other people's moderation records.
  assert.equal(reports.has(unrelated), true);
  assert.equal(reports.get(unrelated).reportedUserId, 41);
});

test('erasure still removes matches, chat, swipes, and blocks', async () => {
  resetAll();
  seedMatch(ME, THEM);
  messages.set(nextId, { id: nextId, matchId: 1, senderId: THEM, body: 'unrelated' });
  swipes.set('a', { swiperId: ME, swipeeId: 44 });
  swipes.set('b', { swiperId: 45, swipeeId: ME });
  blocks.set('c', { blockerId: ME, blockedId: 46 });
  blocks.set('d', { blockerId: 47, blockedId: ME });

  const out = await eraseUserService(ME);

  assert.equal(out.erased, true);
  assert.equal(matches.size, 0);
  assert.equal(messages.size, 0, 'chat authored by anyone in the match goes');
  assert.equal(swipes.size, 0, 'both directions');
  assert.equal(blocks.size, 0, 'both directions');
});

test('erasure reports what it removed', async () => {
  resetAll();
  seedMatch(ME, THEM);
  const out = await eraseUserService(ME);
  assert.equal(out.matchesRemoved, 1);
  // Surfaced rather than swallowed: an image we failed to destroy is a real,
  // reportable gap in the erasure, not a silent partial success.
  assert.deepEqual(out.cloudinaryFailures, []);
});
