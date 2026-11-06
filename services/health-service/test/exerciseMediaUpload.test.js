import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('uploader repairs placeholder URLs, tolerates absent files, and preserves uploaded assets', async () => {
  const published = 'https://res.cloudinary.com/test/image/upload/demo.gif';
  const data = {
    Existing: { mediaId: 'existing', gifUrl: published, imageUrl: published },
    Placeholder: { mediaId: 'repair', gifUrl: 'https://cloudinary.com{CLOUD_NAME}/bad', imageUrl: 'bad', gifFile: 'repair.gif', imageFile: 'repair.jpg' },
    Missing: { mediaId: 'missing', gifUrl: null, imageUrl: null, gifFile: null, imageFile: null },
  };
  const uploads = [];
  const saved = [];
  mock.module('node:fs', {
    namedExports: {
      readFileSync: () => JSON.stringify(data),
      writeFileSync: (_, content) => saved.push(JSON.parse(content)),
      existsSync: () => true,
    },
  });
  mock.module('cloudinary', {
    namedExports: { v2: {
      config: () => {},
      uploader: { upload: async (file, options) => {
        uploads.push({ file, options });
        return { secure_url: `https://res.cloudinary.com/test/image/upload/${options.public_id}` };
      } },
    } },
  });
  const keys = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const originalEnv = keys.map((key) => process.env[key]);
  const originalArgs = process.argv;
  const warn = mock.method(console, 'warn', () => {});
  const log = mock.method(console, 'log', () => {});
  try {
    for (const key of keys) process.env[key] = 'test-placeholder';
    process.argv = ['node', 'uploadExerciseMedia.mjs', '/test-media'];
    await import('../scripts/uploadExerciseMedia.mjs');
    assert.equal(uploads.length, 2);
    assert.ok(uploads.every(({ options }) => options.public_id.startsWith('repair-')));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].Existing.gifUrl, published);
    assert.equal(saved[0].Placeholder.gifUrl, 'https://res.cloudinary.com/test/image/upload/repair-demo');
    assert.equal(saved[0].Missing.gifUrl, null);
    assert.equal(warn.mock.calls.length, 1);
  } finally {
    keys.forEach((key, i) => {
      if (originalEnv[i] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[i];
    });
    process.argv = originalArgs;
    warn.mock.restore();
    log.mock.restore();
  }
});
