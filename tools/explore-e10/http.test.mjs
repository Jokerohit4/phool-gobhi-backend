// Real loopback HTTP + JWT + gateway proxy + auth router; in-memory DB explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { memoryDb } from '../../services/auth-service/test/exploreMemoryDb.js';
import { createExploreService } from '../../services/auth-service/exploration/service.js';
import { catalogueV1 } from '../../services/auth-service/exploration/contracts.js';

test('E10 JWT/gateway/auth integration and E9 ingestion ownership (memory DB)', async t => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'e10-local-only';
  process.env.SECRETS_JSON = '';
  process.env.K_SERVICE = '';
  process.env.INTERNAL_API_KEY = 'e10-local-only';
  const ingested = [];
  t.mock.module('../../utils/analytics.js', { exports: { ingest: x => ingested.push(x) } });
  t.mock.module('../../utils/googleIdToken.js', { exports: { withGoogleIdToken: () => options => options } });
  t.mock.module('../../services/auth-service/node_modules/@prisma/client/default.js', {
    exports: { PrismaClient: class {}, Prisma: {} },
  });
  const attendance = {
    booking: [{ customerId: 1, gymId: 101, attendedAt: new Date('2026-10-18T19:00:00Z') }],
    memberAttendance: [{ customerId: 1, gymId: 101, date: '2026-10-19', checkedInAt: new Date('2026-10-19T03:30:00Z') },
      { customerId: 1, gymId: 101, date: '2026-10-20', checkedInAt: new Date('2026-10-20T03:30:00Z') }],
    independentCheckIn: [{ customerId: 1, unclaimedGymId: 101, date: '2026-10-19', checkedInAt: new Date('2026-10-19T03:30:00Z') }],
  };
  t.mock.module('../../services/booking-service/node_modules/@prisma/client/default.js', {
    exports: { Prisma: {}, PrismaClient: class { constructor() {
      for (const [model, rows] of Object.entries(attendance)) this[model] = {
        findMany: async ({ where }) => rows.filter(row => row.customerId === where.customerId),
      };
    } } },
  });
  const { createExploreRouter } = await import('../../services/auth-service/exploration/routes.js');
  const db = memoryDb();
  const fixture = JSON.parse(readFileSync(new URL('../../services/auth-service/exploration/contract/api-fixtures.json', import.meta.url)));
  const command = fixture.httpCases.find(c => c.name === 'pickup-delayed-first-claim-C1-after-C2').request.body;
  const service = createExploreService({ db, now: () => '2026-10-20T01:30:00Z' });
  await db.exploreCatalogue.createMany({ data: [{ version: 1, hash: catalogueV1.contentHash, payload: catalogueV1 }], skipDuplicates: true });
  const manifest = fixture.manifests[0];
  await db.exploreEpochManifest.createMany({ data: [{ epochManifestId: manifest.epochManifestId, epoch: manifest.epoch,
    worldGeneration: 1, payload: manifest }], skipDuplicates: true });
  const upstream = express(); upstream.use(express.json()); upstream.use('/explore', createExploreRouter(service));
  upstream.get('/internal/101', (req, res) => res.json({ data: { name: 'Local metadata fixture', lat: 12.97, lng: 77.59, city: 'Local' } }));
  const server = upstream.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GYM_SERVICE_URL = process.env.AUTH_SERVICE_URL;
  const { default: bookingRoutes } = await import('../../services/booking-service/routes/booking.js');
  const bookingApp = express(); bookingApp.use('/', bookingRoutes);
  const bookingServer = bookingApp.listen(0, '127.0.0.1');
  await new Promise(r => bookingServer.once('listening', r));
  process.env.BOOKING_SERVICE_URL = `http://127.0.0.1:${bookingServer.address().port}`;
  const { app, CLIENT_EVENT_ALLOWLIST } = await import('../../index.js');
  const gateway = app.listen(0, '127.0.0.1');
  await new Promise(r => gateway.once('listening', r));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const token = (id, role = 'customer', extra = {}) => jwt.sign({ id, role, type: 'general', ...extra }, process.env.JWT_SECRET);
  const request = async (path, bearer, body, extra = {}) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (const bearer of [null, 'bad-token', token(1, 'customer', { exp: 1 })]) {
      const result = await request('/api/auth/explore/collection', bearer, null, { 'x-user-id': '1', 'x-user-role': 'customer' });
      assert.equal(result.status, 401); assert.equal(result.body.error.code, 'AUTH_REQUIRED');
    }
    assert.equal((await request('/api/auth/explore/collection', token(1, 'partner'))).status, 403);
    const saved = await request('/api/auth/explore/pickups', token(1), command, { 'x-user-id': '2', 'x-user-role': 'partner' });
    assert.equal(saved.status, 200); assert.equal(saved.body.data.result, 'saved');
    const replay = await request('/api/auth/explore/pickups', token(1), command);
    assert.equal(replay.body.data.result, 'already_saved');
    assert.equal(replay.body.data.receipt.receiptId, saved.body.data.receipt.receiptId);
    assert.equal((await request('/api/auth/explore/collection', token(2))).body.data.summary.savedFindCount, 0);
    assert.equal((await request('/api/auth/explore/collection', token(1))).body.data.summary.savedFindCount, 1);
    const venues = await request('/api/bookings/mine/visited-gyms?version=2', token(1), null, { 'x-user-id': '2' });
    assert.equal(venues.status, 200);
    assert.deepEqual(venues.body.data.map(row => [row.venueId, row.visitCount]), [['partner:101', 2], ['unclaimed:101', 1]]);
    assert.equal(venues.body.data[1].gym, null);
    const v1 = await request('/api/bookings/mine/visited-gyms', token(1));
    assert.equal(v1.body.data.length, 1); assert.equal(v1.body.data[0].visitCount, 2);
    assert.deepEqual((await request('/api/bookings/mine/visited-gyms?version=2', token(2))).body.data, []);
    assert.equal((await request('/api/bookings/mine/visited-gyms?version=2', null)).status, 401);
    assert.equal((await request('/api/bookings/mine/visited-gyms?version=2', token(1, 'partner'))).status, 403);
    const names = ['explore_visible', 'explore_session_ended', 'explore_find_nearby', 'explore_target_presented',
      'explore_encounter_started', 'explore_encounter_result', 'explore_pickup_pending', 'explore_collection_viewed', 'explore_gym_opened'];
    const serverOnly = ['explore_pickup_saved', 'explore_pickup_rejected', 'explore_daily_set_completed'];
    for (const name of names) assert.ok(CLIENT_EVENT_ALLOWLIST.has(name));
    for (const name of serverOnly) assert.ok(!CLIENT_EVENT_ALLOWLIST.has(name));
    await request('/api/events', null, { events: [...names, ...serverOnly].map(event => ({ event, distinct_id: 'e10-disposable', properties: {} })) });
    assert.deepEqual(ingested.map(e => e.event).sort(), names.sort());
    const previous = process.env.EXPLORE_QUEUE_DIAGNOSTICS;
    try {
      ingested.length = 0;
      const diagnostic = { event: 'explore_pickup_queue_resolved', distinct_id: 'A', properties: {
        measurement_version: 1, occurrence_kind: 'grid', queue_age_bucket: 'under_10s',
        queue_age_basis: 'wall_estimate', failure_reason: 'none', upload_attempts_bucket: '1',
        resolution: 'receipt_observed',
      } };
      delete process.env.EXPLORE_QUEUE_DIAGNOSTICS;
      assert.equal((await request('/api/events', null, diagnostic)).status, 202);
      assert.equal(ingested.length, 0);
      process.env.EXPLORE_QUEUE_DIAGNOSTICS = 'true';
      assert.equal((await request('/api/events', null, diagnostic, { 'user-agent': 'private-device' })).status, 202);
      assert.deepEqual(ingested, [{ event: diagnostic.event, distinctId: 'A', properties: diagnostic.properties, source: 'client' }]);
      await request('/api/events', null, { ...diagnostic, properties: { ...diagnostic.properties, proof: 'forbidden' } });
      assert.equal(ingested.length, 1);
    } finally {
      if (previous === undefined) delete process.env.EXPLORE_QUEUE_DIAGNOSTICS;
      else process.env.EXPLORE_QUEUE_DIAGNOSTICS = previous;
    }
  } finally {
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => server.close(r)), new Promise(r => bookingServer.close(r))]);
  }
});
