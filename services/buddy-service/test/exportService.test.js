// The one place in the platform where the access right and a third party's
// privacy genuinely collide. A conversation is personal data about BOTH
// people. The requester is entitled to their own words and to know a
// conversation happened; the other person never asked for their messages to
// be handed to anyone, and they have no notice and no say in it.
//
// So the export carries the requester's own messages in full and the other
// side's only as a count. These tests exist because that line is easy to
// erase with one well-meaning "include the whole thread so it reads properly"
// change.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ME = 42;
const THEM = 99;

let db;
function resetDb() {
  db = {
    profile: {
      id: 1,
      userId: ME,
      bio: 'my bio',
      socialMediaUrl: null,
      gender: 'male',
      dateOfBirth: null,
      fitnessGoals: ['muscle_gain'],
      lat: 28.45,
      lng: 77.02,
      isDiscoverable: true,
      isActive: true,
      createdAt: new Date('2026-01-01'),
      photos: [{ url: 'https://example.invalid/a.jpg', publicId: 'a', order: 0 }],
      filter: { radiusKm: 25, minAge: 18, maxAge: 60, genders: [], fitnessGoals: [] },
    },
    matches: [{
      id: 7,
      userLowId: ME,
      userHighId: THEM,
      status: 'active',
      matchedAt: new Date('2026-02-01'),
      unmatchedAt: null,
      messages: [
        { senderId: ME, body: 'my words', createdAt: new Date('2026-02-02') },
        { senderId: THEM, body: 'THEIR PRIVATE WORDS', createdAt: new Date('2026-02-03') },
        { senderId: THEM, body: 'MORE OF THEIR WORDS', createdAt: new Date('2026-02-04') },
      ],
    }],
    swipesMade: [{ swipeeId: THEM, action: 'like', createdAt: new Date('2026-01-15') }],
    swipesReceivedCount: 12,
    blocks: [{ blockedId: 55, reason: 'spam', createdAt: new Date('2026-03-01') }],
  };
}

let buildExportService;

test('setup: mock prisma once, import exportService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.buddyProfile = { findUnique: async () => db.profile };
          this.match = { findMany: async () => db.matches };
          this.swipe = {
            findMany: async () => db.swipesMade,
            count: async () => db.swipesReceivedCount,
          };
          this.blockedUser = { findMany: async () => db.blocks };
        }
      },
      Prisma: {},
    },
  });
  ({ buildExportService } = await import('../services/exportService.js'));
  assert.equal(typeof buildExportService, 'function');
});

test('the requester gets their own messages in full', async () => {
  resetDb();
  const out = await buildExportService(ME);

  assert.equal(out.matches.length, 1);
  assert.deepEqual(out.matches[0].messagesYouSent.map((m) => m.body), ['my words']);
});

test('the other person\'s message text never appears anywhere in the document', async () => {
  resetDb();
  const out = await buildExportService(ME);

  // Serialised whole rather than checked field-by-field: a future refactor
  // that leaks the text through some new key still fails this.
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes('THEIR PRIVATE WORDS'),
      'the other party did not consent to their words being exported');
  assert.ok(!serialised.includes('MORE OF THEIR WORDS'));
});

test('received messages are still acknowledged, as a count', async () => {
  resetDb();
  const out = await buildExportService(ME);

  // Omitting them entirely would misrepresent the conversation as one-sided.
  assert.equal(out.matches[0].messagesYouReceived, 2);
  assert.match(out.notIncluded.messagesFromOthers, /only the count/);
});

test('the counterparty id is not handed out with the match', async () => {
  resetDb();
  const out = await buildExportService(ME);

  const match = out.matches[0];
  assert.ok(!('userLowId' in match) && !('userHighId' in match) && !('withUserId' in match),
      'a counterparty id is a handle to someone else\'s account and adds nothing to the requester\'s record');
  assert.ok(match.matchedAt, 'the fact and timing of the match is the requester\'s own data');
});

test('swipes made are itemised; swipes received are only counted', async () => {
  resetDb();
  const out = await buildExportService(ME);

  assert.equal(out.swipes.made.length, 1);
  assert.equal(out.swipes.made[0].onUserId, THEM, 'their own outgoing activity, itemised');
  assert.equal(out.swipes.receivedCount, 12);
  assert.ok(!Array.isArray(out.swipes.received),
      'who swiped on them is other people\'s activity, not theirs');
});

test('the profile the platform holds comes back in full, photos included', async () => {
  resetDb();
  const out = await buildExportService(ME);

  assert.equal(out.profile.bio, 'my bio');
  assert.deepEqual(out.profile.photoUrls, ['https://example.invalid/a.jpg']);
  assert.deepEqual(out.profile.approximateLocation, { lat: 28.45, lng: 77.02 });
  assert.equal(out.discoveryFilter.radiusKm, 25);
});

test('a user who never opened gym-buddy gets a well-formed empty document', async () => {
  resetDb();
  db.profile = null;
  db.matches = [];
  db.swipesMade = [];
  db.swipesReceivedCount = 0;
  db.blocks = [];

  const out = await buildExportService(ME);

  // Must not throw on the missing profile, and must still say what it holds
  // (nothing) rather than half-existing.
  assert.equal(out.profile, null);
  assert.equal(out.discoveryFilter, null);
  assert.deepEqual(out.matches, []);
  assert.equal(out.swipes.receivedCount, 0);
});
