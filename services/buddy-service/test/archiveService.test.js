// Account archive for buddy-service: the person disappears from everyone else's
// view and their matches end, but NOTHING is deleted.
// Run with: node --experimental-test-module-mocks --test test/archiveService.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ME = 10;
const profiles = [];
const matches = [];
const deletes = [];
let archiveUserService;

const matchesWhere = (m, where) => m.status === where.status
  && where.OR.some((c) => c.userLowId === m.userLowId || c.userHighId === m.userHighId);

test('setup: mock prisma, import the archive service', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.buddyProfile = {
            updateMany: async ({ where, data }) => {
              const hit = profiles.filter((p) => p.userId === where.userId);
              hit.forEach((p) => Object.assign(p, data));
              return { count: hit.length };
            },
            deleteMany: async () => { deletes.push('buddyProfile'); return { count: 0 }; },
          };
          this.match = {
            updateMany: async ({ where, data }) => {
              const hit = matches.filter((m) => matchesWhere(m, where));
              hit.forEach((m) => Object.assign(m, data));
              return { count: hit.length };
            },
            deleteMany: async () => { deletes.push('match'); return { count: 0 }; },
          };
          this.chatMessage = { deleteMany: async () => { deletes.push('chatMessage'); return { count: 0 }; } };
          this.buddyPhoto = { deleteMany: async () => { deletes.push('buddyPhoto'); return { count: 0 }; } };
          this.$transaction = async (ops) => Promise.all(ops);
        }
      },
      Prisma: {},
    },
  });
  ({ archiveUserService } = await import('../services/archiveService.js'));
});

function reset() {
  profiles.length = 0; matches.length = 0; deletes.length = 0;
  profiles.push(
    { userId: ME, isActive: true, isDiscoverable: true, bio: 'hello' },
    { userId: 30, isActive: true, isDiscoverable: true, bio: 'other' },
  );
  matches.push(
    { id: 1, userLowId: 10, userHighId: 30, status: 'active' },
    { id: 2, userLowId: 10, userHighId: 40, status: 'unmatched' },
    { id: 3, userLowId: 30, userHighId: 50, status: 'active' },
  );
}

test('archiving hides the profile from the deck and ends their active matches', async () => {
  reset();
  const result = await archiveUserService(ME);
  assert.deepEqual(result, { archived: true, endedMatches: 1 });
  assert.equal(profiles[0].isActive, false);
  assert.equal(profiles[0].isDiscoverable, false);
  assert.equal(matches[0].status, 'unmatched');
  assert.equal(matches[0].unmatchedBy, ME);
});

test('it deletes nothing: the profile row, bio and matches are all still there', async () => {
  reset();
  await archiveUserService(ME);
  assert.deepEqual(deletes, [], 'no delete of any kind may run');
  assert.equal(profiles.find((p) => p.userId === ME).bio, 'hello');
  assert.equal(matches.length, 3);
});

test("other people's profiles and matches are untouched", async () => {
  reset();
  await archiveUserService(ME);
  assert.equal(profiles.find((p) => p.userId === 30).isActive, true);
  assert.equal(matches.find((m) => m.id === 3).status, 'active');
  assert.equal(matches.find((m) => m.id === 2).status, 'unmatched');
});

test('archiving twice, or someone with no buddy profile, is a harmless no-op', async () => {
  reset();
  await archiveUserService(ME);
  assert.deepEqual(await archiveUserService(ME), { archived: true, endedMatches: 0 });
  assert.deepEqual(await archiveUserService(999), { archived: true, endedMatches: 0 });
});
