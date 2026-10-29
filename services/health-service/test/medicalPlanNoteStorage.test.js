import test from 'node:test';
import assert from 'node:assert/strict';

let storage;
const writes = [];
test('setup medical storage with a fake private bucket', async t => {
  t.mock.module('@google-cloud/storage', { namedExports: {
    Storage: class { bucket() { return { file: path => ({ save: async (buffer, options) => {
      writes.push({ path, buffer, options });
    } }) }; } },
  } });
  storage = await import('../services/ledger/medicalDocumentStorage.js');
});

test('plan notes use a random owned medical path and private attachment metadata', async () => {
  const buffer = Buffer.from('Doctor instructions');
  const path = await storage.savePlanNote({ buffer, userId: 7 });
  assert.match(path, /^medical\/7\/[a-f0-9-]+\.txt$/);
  assert.equal(path.includes('Doctor'), false);
  assert.equal(writes.at(-1).buffer, buffer);
  assert.equal(writes.at(-1).options.contentType, 'text/plain');
  assert.equal(writes.at(-1).options.metadata.cacheControl, 'private, no-store');
  assert.equal(writes.at(-1).options.metadata.contentDisposition, 'attachment');
});

test('ordinary file uploads still reject text, HTML and scripts', async () => {
  for (const mimeType of ['text/plain', 'text/html', 'application/javascript']) {
    assert.equal(storage.isAllowedMimeType(mimeType), false);
    await assert.rejects(storage.saveDocument({ buffer: Buffer.from('content'), mimeType, userId: 7 }), { status: 400 });
  }
});

test('plan-note storage rejects empty or oversized buffers before touching the bucket', async () => {
  const before = writes.length;
  for (const buffer of [null, Buffer.alloc(0), Buffer.alloc(64001)]) {
    await assert.rejects(storage.savePlanNote({ buffer, userId: 7 }), { status: 400 });
  }
  assert.equal(writes.length, before);
});
