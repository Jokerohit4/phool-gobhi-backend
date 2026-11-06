import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { isExerciseMediaUrl, demoStatus } from '../utils/exerciseMedia.js';

test('placeholder URLs and absent assets cannot be treated as published demos', () => {
  for (const value of [null, undefined, '', 'https://cloudinary.com{CLOUD_NAME}/image/upload/plank-demo',
    'http://res.cloudinary.com/demo.gif', 'https://user:secret@example.com/demo.gif', 'https://example.com/']) {
    assert.equal(isExerciseMediaUrl(value), false, String(value));
  }
  assert.equal(isExerciseMediaUrl('https://res.cloudinary.com/test/image/upload/v1/demo.gif'), true);
  assert.equal(demoStatus(null), 'missing');
  assert.equal(demoStatus({ gifUrl: 'broken' }), 'invalid_url');
  assert.equal(demoStatus({ gifUrl: 'https://example.com/demo.gif' }), 'needs_review');
});

test('media seeding preserves existing demos for invalid and missing URLs', async () => {
  const updates = [];
  const selected = [];
  mock.module('@prisma/client', {
    namedExports: {
      PrismaClient: class {
        exercise = {
          findFirst: async ({ where }) => { selected.push(where); return { id: where.name.equals }; },
          update: async (args) => { updates.push(args); },
        };
        exerciseContent = { findUnique: async () => ({ id: 'approved-existing-copy' }) };
        $disconnect = async () => {};
      },
    },
  });
  const originalDry = process.env.DRY_RUN;
  delete process.env.DRY_RUN;
  const warn = mock.method(console, 'warn', () => {});
  const log = mock.method(console, 'log', () => {});
  try {
    await import('../prisma/seedExerciseMedia.js');
    assert.ok(updates.length > 0, 'valid uploads still seed');
    assert.ok(selected.every((where) => where.createdByUserId === null));
    assert.ok(!updates.some((u) => u.where.id === 'Plank'), 'fabricated plank URL must not overwrite existing data');
    assert.ok(updates.every((u) => isExerciseMediaUrl(u.data.demoGifUrl) && isExerciseMediaUrl(u.data.demoImageUrl)));
  } finally {
    if (originalDry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = originalDry;
    warn.mock.restore();
    log.mock.restore();
  }
});
