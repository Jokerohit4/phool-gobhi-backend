// Unit + multer-integration tests for the in-repo Cloudinary storage engine
// that replaced multer-storage-cloudinary. Cloudinary is a fake — no network.
// Run with: node --experimental-test-module-mocks --test test/cloudinaryStorage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable, Readable } from 'node:stream';
import multer from 'multer';

import { CloudinaryStorage } from '../utils/cloudinaryStorage.js';

function fakeCloudinary({ failUpload = null } = {}) {
  const calls = { upload: [], destroy: [] };
  return {
    calls,
    uploader: {
      upload_stream(options, cb) {
        const chunks = [];
        calls.upload.push({ options, chunks });
        return new Writable({
          write(chunk, _enc, next) { chunks.push(chunk); next(); },
          final(done) {
            if (failUpload) cb(failUpload);
            else cb(null, { secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/folder/abc.jpg', public_id: 'folder/abc', bytes: Buffer.concat(chunks).length });
            done();
          },
        });
      },
      destroy(publicId, options, cb) { calls.destroy.push({ publicId, options }); cb(null, { result: 'ok' }); },
    },
  };
}

test('requires a cloudinary client', () => {
  assert.throws(() => new CloudinaryStorage({}), /cloudinary/);
});

test('_handleFile streams to upload_stream and returns the multer-storage-cloudinary file shape', async () => {
  const cloudinary = fakeCloudinary();
  const params = { folder: 'phool-gobhi/x', allowed_formats: ['jpg', 'png'], transformation: [{ width: 5 }] };
  const storage = new CloudinaryStorage({ cloudinary, params });
  const out = await new Promise((resolve, reject) => {
    storage._handleFile({}, { stream: Readable.from([Buffer.from('hello'), Buffer.from('world')]) }, (e, f) => (e ? reject(e) : resolve(f)));
  });
  assert.deepEqual(out, { path: 'https://res.cloudinary.com/demo/image/upload/v1/folder/abc.jpg', size: 10, filename: 'folder/abc' });
  assert.deepEqual(cloudinary.calls.upload[0].options, params);
  assert.equal(Buffer.concat(cloudinary.calls.upload[0].chunks).toString(), 'helloworld');
});

test('params may be a function or contain per-file functions', async () => {
  const cloudinary = fakeCloudinary();
  const file = { stream: Readable.from([Buffer.from('a')]), originalname: 'pic.png' };
  await new Promise((resolve, reject) => new CloudinaryStorage({ cloudinary, params: (req, f) => ({ folder: `u/${f.originalname}` }) })
    ._handleFile({}, file, (e) => (e ? reject(e) : resolve())));
  assert.equal(cloudinary.calls.upload[0].options.folder, 'u/pic.png');
  const file2 = { stream: Readable.from([Buffer.from('a')]), originalname: 'z.png' };
  await new Promise((resolve, reject) => new CloudinaryStorage({ cloudinary, params: { folder: (req, f) => `v/${f.originalname}` } })
    ._handleFile({}, file2, (e) => (e ? reject(e) : resolve())));
  assert.equal(cloudinary.calls.upload[1].options.folder, 'v/z.png');
});

test('an upload error is passed to the callback', async () => {
  const boom = new Error('cloudinary 401');
  const storage = new CloudinaryStorage({ cloudinary: fakeCloudinary({ failUpload: boom }), params: {} });
  const err = await new Promise((resolve) => {
    storage._handleFile({}, { stream: Readable.from([Buffer.from('a')]) }, (e) => resolve(e));
  });
  assert.equal(err, boom);
});

test('_removeFile destroys by public_id with invalidate', async () => {
  const cloudinary = fakeCloudinary();
  const storage = new CloudinaryStorage({ cloudinary });
  await new Promise((resolve) => storage._removeFile({}, { filename: 'folder/abc' }, resolve));
  assert.deepEqual(cloudinary.calls.destroy, [{ publicId: 'folder/abc', options: { invalidate: true } }]);
});

async function postMultipart(mw, { size, field = 'image', type = 'image/png' }) {
  const server = http.createServer((req, res) => {
    mw(req, res, (err) => {
      res.setHeader('content-type', 'application/json');
      if (err) { res.statusCode = 400; res.end(JSON.stringify({ error: err.code || err.message })); return; }
      const f = req.file || (req.files && req.files[0]);
      res.end(JSON.stringify({ path: f && f.path, filename: f && f.filename, size: f && f.size }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const form = new FormData();
    form.append(field, new Blob([Buffer.alloc(size, 1)], { type }), 'pic.png');
    const resp = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: form });
    return { status: resp.status, body: await resp.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('works as a multer storage: file.path/filename/size are set and limits are enforced', async () => {
  const cloudinary = fakeCloudinary();
  const upload = multer({
    storage: new CloudinaryStorage({ cloudinary, params: { folder: 'f' } }),
    limits: { fileSize: 1024 },
    fileFilter: (req, file, cb) => (file.mimetype === 'image/png' ? cb(null, true) : cb(new Error('Invalid file type'))),
  });

  const ok = await postMultipart(upload.single('image'), { size: 500 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { path: 'https://res.cloudinary.com/demo/image/upload/v1/folder/abc.jpg', filename: 'folder/abc', size: 500 });

  const tooBig = await postMultipart(upload.single('image'), { size: 5000 });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.body.error, 'LIMIT_FILE_SIZE');

  const before = cloudinary.calls.upload.length;
  const badType = await postMultipart(upload.single('image'), { size: 10, type: 'application/pdf' });
  assert.equal(badType.status, 400);
  assert.match(badType.body.error, /Invalid file type/);
  assert.equal(cloudinary.calls.upload.length, before, 'filtered files are never uploaded');
});
