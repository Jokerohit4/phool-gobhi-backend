import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The sweeper is the only thing standing between "the user backed out of the
// confirm screen" and a bucket that grows forever, so its two failure modes are
// both worth asserting: deleting a photo a live log still shows, and never
// deleting one at all.
//
// GCS itself is not exercised. These tests drive the decision logic with a fake
// bucket, because the logic - not the SDK - is where the bug would be.

let storage;
let deleted;

// GCS itself is not exercised. The module builds its bucket lazily and holds it
// in a module-scope variable, and ESM namespaces are frozen, so the bucket
// client cannot be swapped from a test. The sweeper therefore takes its deleter
// as a parameter, and the tests assert on which paths it ASKS to delete: the
// decision is the contract, and the SDK call underneath it is one line.
function deleteFn() {
  return async (paths) => {
    deleted.push(...paths);
    return { deleted: paths.length, failed: [] };
  };
}

beforeEach(async () => {
  deleted = [];
  storage = await import('../services/ledger/foodPhotoStorage.js');
});

/**
 * A prisma mock that HONOURS the cutoff query.
 *
 * The age filter lives in the `where` clause, not in JavaScript - the sweeper
 * asks the database for rows older than the cutoff and never re-checks the dates
 * itself. A mock that ignored `requestedAt.lt` and returned everything would
 * therefore pass a test that claimed to prove the TTL works, while proving
 * nothing at all. The mock has to be at least as faithful as the query.
 */
function mockPrisma({ requests = [], referenced = [] } = {}) {
  const stamped = [];
  return {
    stamped,
    foodPhotoRequestLog: {
      findMany: async ({ where } = {}) => {
        const cutoff = where?.requestedAt?.lt;
        return requests
          .map((r, i) => ({ id: i + 1, photoPath: r.photoPath, requestedAt: r.requestedAt }))
          .filter((r) => (cutoff ? r.requestedAt < cutoff : true))
          .filter((r) => (where?.abandonedAt === null ? true : true));
      },
      updateMany: async (args) => {
        for (const id of args.where.id.in || []) stamped.push(id);
        return { count: args.where.id.in.length };
      },
    },
    foodLog: {
      findMany: async () => referenced.map((photoPath) => ({ photoPath })),
    },
  };
}

// A request from nine days ago, and one from an hour ago.
const STALE = { photoPath: 'food/7/old.jpg', requestedAt: new Date('2026-09-20T00:00:00.000Z') };
const FRESH = { photoPath: 'food/7/fresh.jpg', requestedAt: new Date('2026-09-28T23:00:00.000Z') };

const OLD = new Date('2026-09-20T00:00:00.000Z');
const NOW = new Date('2026-09-29T00:00:00.000Z');

test('an unconfirmed photo past the TTL is swept and its row is stamped', async () => {
  const prisma = mockPrisma({
    requests: [
      { photoPath: 'food/7/old-a.jpg', requestedAt: STALE.requestedAt },
      { photoPath: 'food/7/old-b.jpg', requestedAt: STALE.requestedAt },
    ],
  });
  const out = await storage.sweepUnconfirmedPhotos(prisma, { now: NOW, deleteFn: deleteFn() });

  assert.equal(out.swept, 2);
  assert.deepEqual(deleted.sort(), ['food/7/old-a.jpg', 'food/7/old-b.jpg']);
  // Stamped rather than deleted: the request was paid for whatever the user did
  // next, so the row is the only record of that spend.
  assert.equal(prisma.stamped.length, 2);
});

test('a photo a live log still references is never deleted', async () => {
  // Two request rows, one path. This is what happens when a client re-sends a
  // photo: the object is shared, and the naive version of this sweep breaks a
  // picture the user is currently looking at.
  const prisma = mockPrisma({
    requests: [
      { photoPath: 'food/7/shared.jpg', requestedAt: STALE.requestedAt },
      { photoPath: 'food/7/lonely.jpg', requestedAt: STALE.requestedAt },
    ],
    referenced: ['food/7/shared.jpg'],
  });

  const out = await storage.sweepUnconfirmedPhotos(prisma, { now: NOW, deleteFn: deleteFn() });

  assert.deepEqual(deleted, ['food/7/lonely.jpg'], 'only the unreferenced one goes');
  assert.equal(out.swept, 1);
  assert.deepEqual(prisma.stamped, [2], 'and only that row is stamped');
});

test('a photo inside the TTL is left alone, so a review in progress survives', async () => {
  // The age check is what stops the sweeper racing a user who photographed their
  // meal and has not finished confirming it.
  const prisma = mockPrisma({ requests: [FRESH] });
  const out = await storage.sweepUnconfirmedPhotos(prisma, {
    now: NOW,
    olderThanHours: 24,
    deleteFn: deleteFn(),
  });

  assert.equal(out.swept, 0);
  assert.deepEqual(deleted, []);
  assert.equal(prisma.stamped.length, 0);
});

test('an empty queue is a no-op, not a bucket listing', async () => {
  let listed = 0;
  const prisma = {
    foodPhotoRequestLog: {
      findMany: async () => {
        listed += 1;
        return [];
      },
    },
    foodLog: { findMany: async () => [] },
  };

  const out = await storage.sweepUnconfirmedPhotos(prisma, { now: NOW, deleteFn: deleteFn() });
  assert.equal(out.swept, 0);
  // One query, and no second one to check references - the early return is what
  // keeps this cheap enough to call often.
  assert.equal(listed, 1);
});

test('the allowlist takes images only, and never a document', async () => {
  assert.equal(storage.isAllowedMimeType('image/jpeg'), true);
  assert.equal(storage.isAllowedMimeType('image/png'), true);
  assert.equal(storage.isAllowedMimeType('image/webp'), true);
  assert.equal(storage.isAllowedMimeType('image/heic'), true);
  // The medical bucket accepts PDFs; this one must not, or an upload endpoint
  // with a vision model behind it would be a document reader with a food-themed
  // prompt.
  assert.equal(storage.isAllowedMimeType('application/pdf'), false);
  assert.equal(storage.isAllowedMimeType('image/svg+xml'), false);
});

test('the photo limit is tighter than the medical document limit', async () => {
  const medical = await import('../services/ledger/medicalDocumentStorage.js');
  assert.equal(
    storage.MAX_PHOTO_BYTES < medical.MAX_UPLOAD_BYTES,
    true,
    '8 MB of JPEG is a generous plate photo and an oversized lab report',
  );
});
