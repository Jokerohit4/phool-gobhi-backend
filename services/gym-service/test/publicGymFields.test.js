// Public gym responses must not leak internal columns.
// GET /api/gyms and GET /api/gyms/:id are public at the gateway, so the
// controllers serialise through utils/publicGym.js for EVERY caller. Owner
// (partner/mine) and gobhi (admin/all, admin/:id) routes keep the full row.
//
// Run: node --experimental-test-module-mocks --test test/publicGymFields.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const INTERNAL_FIELDS = [
  'brandDocs', 'commissionPct', 'partnershipStartDate', 'rejectionReason',
  'quotedPrice', 'attendanceSaasOptedOut', 'partnerId', 'marketplaceEnabled',
  'isApproved', 'subscriptionCommissionPct', 'subscriptionPricingMode',
  'subscriptionFlatFeePerUser', 'googlePlaceId', 'googleRatingUpdatedAt',
  'createdAt', 'updatedAt',
];

function fullRow(id = 5) {
  return {
    id,
    partnerId: 77,
    name: 'Iron Temple',
    description: 'desc',
    address: '1 Main St',
    city: 'Gurugram',
    state: 'HR',
    lat: 28.4,
    lng: 77.0,
    amenities: ['wifi'],
    phone: '+911234567890',
    sessionPrice: 200,
    quotedPrice: 240,
    established: 2015,
    brandDocs: ['https://res.cloudinary.com/democloud/image/upload/v1/secret-licence.pdf'],
    openTime: '06:00',
    closeTime: '22:00',
    slotDuration: 60,
    capacity: 20,
    rating: 4.5,
    ratingCount: 10,
    googlePlaceId: 'place-1',
    googleRating: 4.4,
    googleRatingCount: 100,
    googleRatingUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    equipmentRating: 4,
    equipmentRatingCount: 3,
    isApproved: true,
    rejectionReason: 'old reason',
    isActive: true,
    commissionPct: 12.5,
    partnershipStartDate: new Date('2026-01-01T00:00:00Z'),
    subscriptionCommissionPct: 7,
    attendanceSaasOptedOut: true,
    marketplaceEnabled: true,
    subscriptionPricingMode: 'flatPerUser',
    subscriptionFlatFeePerUser: 1,
    weeklyPlanPrice: 500,
    monthlyPlanPrice: 1500,
    quarterlyPlanPrice: null,
    sixMonthlyPlanPrice: null,
    yearlyPlanPrice: 9000,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    images: [{ id: 1, gymId: id, url: 'https://x/img.jpg', publicId: 'pub-1', mediaType: 'image', createdAt: new Date() }],
  };
}

let rows = [];
let ctrl;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.gym = {
            findMany: async ({ where } = {}) => (where && where.partnerId != null
              ? rows.filter((r) => r.partnerId === where.partnerId)
              : rows).map((r) => ({ ...r })),
            findUnique: async ({ where }) => {
              const r = rows.find((x) => x.id === where.id);
              return r ? { ...r, reviews: [{ id: 9, gymId: r.id, customerId: 3, rating: 5, comment: 'great' }] } : null;
            },
          };
        }
      },
      Prisma: {},
    },
  });
  ctrl = await import('../controllers/gymController.js');
});

function assertPublic(gym) {
  for (const f of INTERNAL_FIELDS) {
    assert.equal(f in gym, false, `public gym leaks ${f}`);
  }
}

test('anonymous list omits every internal field', async () => {
  rows = [fullRow(1), fullRow(2)];
  const res = mockRes();
  await ctrl.listGyms({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 2);
  for (const g of res.body.data) assertPublic(g);
  assert.equal(JSON.stringify(res.body).includes('secret-licence'), false);
});

test('anonymous detail omits every internal field and image internals', async () => {
  rows = [fullRow(5)];
  const res = mockRes();
  await ctrl.getGym({ params: { id: '5' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assertPublic(res.body.data);
  assert.deepEqual(Object.keys(res.body.data.images[0]).sort(), ['id', 'mediaType', 'url']);
  assert.equal(JSON.stringify(res.body).includes('secret-licence'), false);
  assert.equal(JSON.stringify(res.body).includes('pub-1'), false);
});

test('customer role (identity headers present) gets the same public view', async () => {
  rows = [fullRow(5)];
  const headers = { 'x-user-id': '3', 'x-user-role': 'customer' };
  const list = mockRes();
  await ctrl.listGyms({ query: {}, headers }, list);
  assertPublic(list.body.data[0]);
  const one = mockRes();
  await ctrl.getGym({ params: { id: '5' }, headers }, one);
  assertPublic(one.body.data);
});

test('owner partner and gobhi headers do not widen the public routes', async () => {
  rows = [fullRow(5)];
  for (const headers of [
    { 'x-user-id': '77', 'x-user-role': 'partner' },
    { 'x-user-id': '1', 'x-user-role': 'gobhi' },
  ]) {
    const res = mockRes();
    await ctrl.getGym({ params: { id: '5' }, headers }, res);
    assertPublic(res.body.data);
  }
});

test('non-sensitive fields the clients read are unchanged', async () => {
  rows = [fullRow(5)];
  const res = mockRes();
  await ctrl.getGym({ params: { id: '5' }, headers: {} }, res);
  const g = res.body.data;
  const src = fullRow(5);
  for (const f of [
    'id', 'name', 'description', 'address', 'city', 'state', 'lat', 'lng', 'amenities', 'phone',
    'sessionPrice', 'established', 'openTime', 'closeTime', 'slotDuration', 'capacity', 'rating',
    'ratingCount', 'googleRating', 'googleRatingCount', 'equipmentRating', 'equipmentRatingCount',
    'isActive', 'weeklyPlanPrice', 'monthlyPlanPrice', 'yearlyPlanPrice',
  ]) {
    assert.deepEqual(g[f], src[f], f);
  }
  assert.equal(g.images[0].url, 'https://x/img.jpg');
  assert.equal(g.reviews.length, 1);
  assert.equal(g.reviews[0].comment, 'great');
});

test('distanceKm is kept on the list when a location is supplied', async () => {
  const { toPublicGym } = await import('../utils/publicGym.js');
  assert.equal(toPublicGym({ ...fullRow(1), distanceKm: 3.2 }).distanceKm, 3.2);
});

test('owner route (partner/mine) and admin routes keep the full row', async () => {
  rows = [fullRow(5)];
  const mine = mockRes();
  await ctrl.getPartnerGyms({ userId: 77 }, mine);
  assert.equal(mine.statusCode, 200);
  const g = mine.body.data[0];
  assert.deepEqual(g.brandDocs, fullRow(5).brandDocs);
  assert.equal(g.commissionPct, 12.5);
  assert.equal(g.rejectionReason, 'old reason');
  assert.equal(g.attendanceSaasOptedOut, true);
  assert.equal(g.marketplaceEnabled, true);

  const adminOne = mockRes();
  await ctrl.getGymAdmin({ params: { id: '5' } }, adminOne);
  assert.equal(adminOne.body.data.commissionPct, 12.5);
  assert.deepEqual(adminOne.body.data.brandDocs, fullRow(5).brandDocs);

  const adminAll = mockRes();
  await ctrl.listGymsAdmin({ query: {} }, adminAll);
  assert.equal(adminAll.statusCode, 200);
  assert.equal(adminAll.body.data[0].commissionPct, 12.5);
  assert.deepEqual(adminAll.body.data[0].brandDocs, fullRow(5).brandDocs);
});
