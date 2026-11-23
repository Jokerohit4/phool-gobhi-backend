// Legacy document URL paths must only persist assets on OUR Cloudinary cloud:
// POST /:id/docs {url}, brandDocs on gym create/update, and doc_add edit
// requests at approval time. Prisma and Cloudinary are mocked.
//
// Run: node --experimental-test-module-mocks --test test/docUrlValidation.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
process.env.CLOUDINARY_API_KEY = 'key123';
process.env.CLOUDINARY_API_SECRET = 'secret456';

const GOOD = 'https://res.cloudinary.com/democloud/image/upload/v1/phool-gobhi/docs/abc.pdf';
const stores = { gym: new Map(), edit: [], claims: 0, updates: 0 };

let ctrl;
let svc;
let docUpload;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    namedExports: {
      PrismaClient: class {
        constructor() {
          this.gym = {
            findUnique: async ({ where }) => stores.gym.get(where.id) ?? null,
            update: async ({ where, data }) => {
              stores.updates += 1;
              const g = stores.gym.get(where.id);
              if (data.brandDocs?.push) g.brandDocs = [...g.brandDocs, data.brandDocs.push];
              return { ...g, brandDocs: g.brandDocs };
            },
          };
          this.gymEditRequest = {
            findFirst: async () => null,
            findUnique: async ({ where }) => stores.edit.find((e) => e.id === where.id) ?? null,
            create: async ({ data }) => {
              const row = { id: stores.edit.length + 1, status: 'pending', ...data };
              stores.edit.push(row);
              return row;
            },
            updateMany: async () => {
              stores.claims += 1;
              return { count: 1 };
            },
          };
          this.$transaction = async (fn) => fn(this);
        }
      },
    },
  });
  t.mock.module('../config/cloudinary.js', {
    defaultExport: { utils: {}, api: {}, uploader: { destroy: async () => {} } },
  });
  ctrl = await import('../controllers/gymController.js');
  svc = await import('../services/gymService.js');
  docUpload = await import('../utils/docUpload.js');
});

function reset() {
  stores.gym.clear();
  stores.edit.length = 0;
  stores.claims = 0;
  stores.updates = 0;
  stores.gym.set(5, { id: 5, partnerId: 7, isApproved: false, brandDocs: [] });
}

test('isTrustedDocUrl: accepts our cloud, rejects everything else', () => {
  const ok = docUpload.isTrustedDocUrl;
  assert.equal(ok(GOOD), true);
  const bad = [
    'http://res.cloudinary.com/democloud/image/upload/v1/a.pdf',
    'https://res.cloudinary.com/othercloud/image/upload/v1/a.pdf',
    'https://evil.example.com/democloud/a.pdf',
    'https://res.cloudinary.com.evil.example/democloud/a.pdf',
    'https://user:pw@res.cloudinary.com/democloud/image/upload/a.pdf',
    'https://res.cloudinary.com:8443/democloud/image/upload/a.pdf',
    'https://res.cloudinary.com/democloud/image/upload/a.pdf?x=1',
    'https://res.cloudinary.com/democloud/image/upload/a.pdf#frag',
    'https://res.cloudinary.com/democloud/',
    'https://res.cloudinary.com/democloud',
    'https://res.cloudinary.com/democloud/%2e%2e/othercloud/a.pdf',
    'https://res.cloudinary.com/democloudx/image/a.pdf',
    'javascript:alert(1)',
    'data:text/html,hi',
    '//res.cloudinary.com/democloud/a.pdf',
    'https://res.cloudinary.com/democloud/' + 'a'.repeat(600),
    '',
    null,
    undefined,
    42,
    { href: GOOD },
  ];
  for (const u of bad) assert.equal(ok(u), false, String(u));
  // Fails closed when the cloud name is not configured.
  assert.equal(ok(GOOD, null), false);
});

test('POST /:id/docs JSON {url}: arbitrary url -> 400 and nothing persisted', async () => {
  reset();
  for (const url of ['https://evil.example.com/x.pdf', 'http://res.cloudinary.com/democloud/a.pdf', 'https://res.cloudinary.com/other/a.pdf']) {
    const res = mockRes();
    await ctrl.addGymDoc({ params: { id: '5' }, body: { url }, userId: 7 }, res);
    assert.equal(res.statusCode, 400, url);
  }
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
  assert.equal(stores.edit.length, 0);
});

test('POST /:id/docs JSON {url}: our Cloudinary url still works (unapproved and approved gym)', async () => {
  reset();
  const res = mockRes();
  await ctrl.addGymDoc({ params: { id: '5' }, body: { url: GOOD }, userId: 7 }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(stores.gym.get(5).brandDocs, [GOOD]);

  reset();
  stores.gym.get(5).isApproved = true;
  const res2 = mockRes();
  await ctrl.addGymDoc({ params: { id: '5' }, body: { url: GOOD }, userId: 7 }, res2);
  assert.equal(res2.statusCode, 201);
  assert.equal(res2.body.data.pending, true);
  assert.equal(stores.edit[0].payload.url, GOOD);
});

test('POST /:id/docs with neither file nor url is still 400', async () => {
  reset();
  const res = mockRes();
  await ctrl.addGymDoc({ params: { id: '5' }, body: {}, userId: 7 }, res);
  assert.equal(res.statusCode, 400);
});

test('updateGym / createGym reject untrusted brandDocs; trusted ones pass validation', async () => {
  reset();
  await assert.rejects(
    () => svc.updateGym(5, 7, { brandDocs: ['https://evil.example.com/x.pdf'] }),
    (e) => e.status === 400,
  );
  await assert.rejects(() => svc.updateGym(5, 7, { brandDocs: 'https://evil.example.com/x.pdf' }), (e) => e.status === 400);
  await assert.rejects(() => svc.createGym(7, { brandDocs: ['javascript:alert(1)'] }), (e) => e.status === 400);
  assert.equal(stores.updates, 0);
});

test('approving a legacy doc_add with an arbitrary url is refused and not claimed', async () => {
  reset();
  stores.gym.get(5).isApproved = true;
  stores.edit.push({ id: 1, gymId: 5, status: 'pending', changeType: 'doc_add', payload: { url: 'https://evil.example.com/x.pdf' } });
  await assert.rejects(() => svc.approveEditRequest(1, 99), (e) => e.status === 400);
  assert.equal(stores.claims, 0);
  assert.deepEqual(stores.gym.get(5).brandDocs, []);
});

test('approving a doc_add with a trusted url applies it', async () => {
  reset();
  stores.gym.get(5).isApproved = true;
  stores.edit.push({ id: 1, gymId: 5, status: 'pending', changeType: 'doc_add', payload: { url: GOOD } });
  await svc.approveEditRequest(1, 99);
  assert.equal(stores.claims, 1);
  assert.deepEqual(stores.gym.get(5).brandDocs, [GOOD]);
});
