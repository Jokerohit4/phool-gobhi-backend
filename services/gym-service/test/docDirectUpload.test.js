// Browser-direct document upload: signature + register endpoints
// (controllers/gymController.js getDocUploadSignature / registerGymDoc,
// utils/docUpload.js, gymService.registerGymDoc). Cloudinary and Prisma are
// mocked; these pin ownership, folder scoping, format/size checks, that the
// persisted URL comes from Cloudinary (not the client), and idempotency.
//
// Run: node --experimental-test-module-mocks --test test/docDirectUpload.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
process.env.CLOUDINARY_API_KEY = 'key123';
process.env.CLOUDINARY_API_SECRET = 'secret456';

const stores = { gym: new Map(), edit: [] };
const cloud = { resource: null, resourceErr: null, destroyed: [], signed: [] };

let ctrl;
let svc;

function gym(over = {}) {
  const g = { id: 5, partnerId: 7, isApproved: false, brandDocs: [], ...over };
  stores.gym.set(g.id, g);
  return g;
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

test('setup: mock prisma + cloudinary and import', async (t) => {
  t.mock.module('@prisma/client', {
    namedExports: {
      PrismaClient: class {
        constructor() {
          this.gym = {
            findUnique: async ({ where }) => stores.gym.get(where.id) ?? null,
            update: async ({ where, data }) => {
              const g = stores.gym.get(where.id);
              if (data.brandDocs?.push) g.brandDocs = [...g.brandDocs, data.brandDocs.push];
              return { brandDocs: g.brandDocs };
            },
          };
          this.gymEditRequest = {
            findFirst: async ({ where }) =>
              stores.edit.find((e) => e.gymId === where.gymId && e.payload.url === where.payload.equals && e.status === 'pending') ?? null,
            create: async ({ data }) => {
              const row = { id: stores.edit.length + 1, status: 'pending', ...data };
              stores.edit.push(row);
              return row;
            },
            updateMany: async () => ({}),
          };
          this.$transaction = async (fn) => fn(this);
        }
      },
    },
  });
  t.mock.module('../config/cloudinary.js', {
    defaultExport: {
      utils: {
        api_sign_request: (params, secret) => {
          cloud.signed.push({ params, secret });
          return 'sig-abc';
        },
      },
      api: {
        resource: async (publicId) => {
          if (cloud.resourceErr) throw cloud.resourceErr;
          return cloud.resource(publicId);
        },
      },
      uploader: {
        destroy: async (publicId) => {
          cloud.destroyed.push(publicId);
        },
      },
    },
  });
  ctrl = await import('../controllers/gymController.js');
  svc = await import('../services/gymService.js');
  assert.ok(ctrl.registerGymDoc && svc.registerGymDoc);
});

function reset() {
  stores.gym.clear();
  stores.edit.length = 0;
  cloud.resourceErr = null;
  cloud.destroyed.length = 0;
  cloud.signed.length = 0;
  cloud.resource = (publicId) => ({
    public_id: publicId,
    type: 'upload',
    resource_type: 'image',
    format: 'pdf',
    bytes: 2 * 1024 * 1024,
    secure_url: `https://res.cloudinary.com/democloud/image/upload/v1/${publicId}.pdf`,
  });
}

const reqFor = (gymId, body, userId = 7) => ({ params: { id: String(gymId) }, body, userId });
const PID = 'phool-gobhi/docs/5/abcDEF123';

// --- signature ---------------------------------------------------------

test('signature: owner gets params scoped to the gym folder', async () => {
  reset();
  gym();
  const res = mockRes();
  await ctrl.getDocUploadSignature(reqFor(5), res);
  assert.equal(res.statusCode, 200);
  const d = res.body.data;
  assert.equal(d.folder, 'phool-gobhi/docs/5');
  assert.equal(d.cloudName, 'democloud');
  assert.equal(d.apiKey, 'key123');
  assert.equal(d.signature, 'sig-abc');
  assert.equal(d.resourceType, 'auto');
  assert.equal(d.type, 'upload');
  assert.equal(d.maxBytes, 10 * 1024 * 1024);
  assert.equal(d.allowedFormats, 'jpg,jpeg,png,webp,pdf');
  assert.equal(cloud.signed[0].params.folder, 'phool-gobhi/docs/5');
  assert.equal(cloud.signed[0].params.allowed_formats, 'jpg,jpeg,png,webp,pdf');
  assert.equal(cloud.signed[0].secret, 'secret456');
  assert.equal(JSON.stringify(res.body).includes('secret456'), false);
});

test('signature: foreign gym is 403, unknown 404, malformed id 400 - nothing signed', async () => {
  reset();
  gym({ partnerId: 99 });
  let res = mockRes();
  await ctrl.getDocUploadSignature(reqFor(5), res);
  assert.equal(res.statusCode, 403);
  res = mockRes();
  await ctrl.getDocUploadSignature(reqFor(6), res);
  assert.equal(res.statusCode, 404);
  res = mockRes();
  await ctrl.getDocUploadSignature(reqFor('5/../6'), res);
  assert.equal(res.statusCode, 400);
  assert.equal(cloud.signed.length, 0);
});

// --- register ----------------------------------------------------------

test('register: success persists the Cloudinary secure_url (not a client url)', async () => {
  reset();
  gym();
  const res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID, resourceType: 'image', url: 'https://evil.example/x.pdf', bytes: 1 }), res);
  assert.equal(res.statusCode, 201);
  const url = `https://res.cloudinary.com/democloud/image/upload/v1/${PID}.pdf`;
  assert.equal(res.body.data.url, url);
  assert.deepEqual(stores.gym.get(5).brandDocs, [url]);
});

test('register: foreign gym is 403 and persists nothing', async () => {
  reset();
  gym({ partnerId: 99 });
  const res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
});

test('register: public id outside this gym folder is rejected without touching Cloudinary', async () => {
  reset();
  gym();
  let called = false;
  const original = cloud.resource;
  cloud.resource = (p) => {
    called = true;
    return original(p);
  };
  for (const publicId of [
    'phool-gobhi/docs/6/abc', // another gym
    'phool-gobhi/docs/abc', // legacy shared folder
    'phool-gobhi/docs/5/a/b', // nested
    'phool-gobhi/docs/5/../6/x',
    'phool-gobhi/docs/5/', // empty
    'phool-gobhi/docs/55/abc', // prefix collision
    '',
    undefined,
    42,
  ]) {
    const res = mockRes();
    await ctrl.registerGymDoc(reqFor(5, { publicId }), res);
    assert.equal(res.statusCode, 400, String(publicId));
  }
  assert.equal(called, false);
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
});

test('register: non-image resourceType rejected', async () => {
  reset();
  gym();
  const res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID, resourceType: 'video' }), res);
  assert.equal(res.statusCode, 400);
});

test('register: oversize asset rejected with 413 and discarded', async () => {
  reset();
  gym();
  const base = cloud.resource;
  cloud.resource = (p) => ({ ...base(p), bytes: 10 * 1024 * 1024 + 1 });
  const res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID, bytes: 100 }), res);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(cloud.destroyed, [PID]);
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
});

test('register: disallowed format rejected and discarded', async () => {
  reset();
  gym();
  const base = cloud.resource;
  cloud.resource = (p) => ({ ...base(p), format: 'gif' });
  const res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID, format: 'pdf' }), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(cloud.destroyed, [PID]);
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
});

test('register: asset missing in Cloudinary -> 400; Cloudinary outage -> 502', async () => {
  reset();
  gym();
  cloud.resourceErr = { http_code: 404, message: 'Resource not found' };
  let res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 400);
  cloud.resourceErr = { http_code: 500, message: 'boom' };
  res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
});

test('register: non-upload delivery type (e.g. authenticated/private) is refused', async () => {
  reset();
  gym();
  const base = cloud.resource;
  cloud.resource = (p) => ({ ...base(p), type: 'private' });
  const res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 400);
});

test('register: idempotent - second call returns 200 and does not duplicate', async () => {
  reset();
  gym();
  let res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 201);
  res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.alreadyRegistered, true);
  assert.equal(stores.gym.get(5).brandDocs.length, 1);
});

test('register: approved gym goes through an edit request, retried call does not duplicate it', async () => {
  reset();
  gym({ isApproved: true });
  let res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.pending, true);
  assert.equal(stores.edit.length, 1);
  assert.equal(stores.edit[0].changeType, 'doc_add');
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
  res = mockRes();
  await ctrl.registerGymDoc(reqFor(5, { publicId: PID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(stores.edit.length, 1);
});
