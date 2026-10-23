// Run ONLY through rehearse.mjs. DB/auth/routers/proxy are real; time/catalogue are injected.
// External export/erasure fan-out and analytics sinks are explicit local substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { createExploreService as realExploreService } from '../../services/auth-service/exploration/service.js';
import { catalogueV1, resolveGrid, parseOccurrence, windowBounds } from '../../services/auth-service/exploration/contracts.js';

test('E10 disposable PostgreSQL / JWT / real gateway proxies', { timeout: 150000 }, async t => {
  assert.match(process.env.E10_OWNED_DATABASE ?? '', /^explore-e10-[0-9a-f]{12}$/);
  const uri = new URL(process.env.DATABASE_URL);
  assert.equal(uri.hostname, '127.0.0.1');
  assert.ok(['/e10_runtime', '/e10_upgrade', '/e10_upgrade_empty'].includes(uri.pathname));
  const { PrismaClient: AuthClient } = await import('./.runtime/auth-client/index.js');
  const { PrismaClient: BookingClient } = await import('./.runtime/booking-client/index.js');
  const db = new AuthClient({ datasourceUrl: uri.href });
  const bookingDb = new BookingClient({ datasourceUrl: uri.href });
  const sql = new pg.Client({ connectionString: uri.href }); await sql.connect();
  const servers = [], downstream = [], analytics = [];
  let timestamp = '2026-10-19T05:29:00Z', currentCatalogue = catalogueV1;
  let holdAfterCommit = false, releaseHeldResponse;
  const serve = async app => {
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise(r => server.once('listening', r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  try {
    // Real HTTP metadata substitute; all other outbound service URLs point here too.
    const fake = express(); fake.use(express.json());
    fake.use((req, res) => {
      downstream.push({ method: req.method, path: req.path });
      if (req.method === 'GET' && req.path === '/internal/101') return res.json({ data: { name: 'Local Gym', lat: 12.97, lng: 77.59, city: 'Local' } });
      res.status(404).json({ error: 'local fixture has no such resource' });
    });
    const fakeUrl = await serve(fake);
    for (const service of ['GYM', 'WALLET', 'HEALTH', 'CHALLENGE', 'BUDDY']) process.env[`${service}_SERVICE_URL`] = fakeUrl;
    process.env.ANALYTICS_PROVIDER = 'none';
    const authRequire = createRequire(new URL('../../services/auth-service/package.json', import.meta.url));
    const bookingRequire = createRequire(new URL('../../services/booking-service/package.json', import.meta.url));
    // Substitute ONLY the module binding to generated clients; every DB call goes to PostgreSQL.
    t.mock.module(authRequire.resolve('@prisma/client'), { exports: { PrismaClient: class { constructor() { return db; } }, Prisma: {} } });
    t.mock.module(bookingRequire.resolve('@prisma/client'), { exports: { PrismaClient: class { constructor() { return bookingDb; } }, Prisma: {} } });
    t.mock.module('../../services/auth-service/utils/exportAcrossServices.js', {
      exports: { exportUserAcrossServices: async () => ({ sections: {}, failures: [] }) },
    });
    t.mock.module('../../services/auth-service/utils/eraseAcrossServices.js', {
      exports: { eraseUserAcrossServices: async () => ({ ok: true, results: [], failures: [] }) },
    });
    for (const path of ['../../utils/analytics.js', '../../services/auth-service/utils/analytics.js', '../../services/booking-service/utils/analytics.js']) {
      t.mock.module(path, { exports: { ingest: event => analytics.push(event), track: (...event) => analytics.push(event) } });
    }
    t.mock.module('../../services/auth-service/exploration/service.js', {
      exports: { createExploreService: options => realExploreService({ ...options,
        now: () => timestamp, currentCatalogue: () => currentCatalogue }) },
    });
    const { default: authRoutes } = await import('../../services/auth-service/routes/auth.js');
    const { default: bookingRoutes } = await import('../../services/booking-service/routes/booking.js');
    const auth = express(); auth.use(express.json());
    auth.use((req, res, next) => {
      const json = res.json.bind(res);
      res.json = body => {
        // Router receives a result only after the real Prisma transaction commits.
        if (holdAfterCommit && req.path === '/explore/pickups' && body.data?.result === 'saved') {
          holdAfterCommit = false;
          releaseHeldResponse = () => { if (!res.destroyed) json(body); };
          return res;
        }
        return json(body);
      };
      next();
    });
    auth.use('/', authRoutes);
    const booking = express(); booking.use(express.json()); booking.use('/', bookingRoutes);
    process.env.AUTH_SERVICE_URL = await serve(auth);
    process.env.BOOKING_SERVICE_URL = await serve(booking);
    const { app } = await import('../../index.js'); const base = await serve(app);
    const token = (id, role = 'customer', extra = {}) => jwt.sign({ id, role, type: 'general', ...extra }, process.env.JWT_SECRET);
    const request = async (path, { user = 1, role = 'customer', bearer = token(user, role), body, method = body ? 'POST' : 'GET', headers = {} } = {}) => {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text(); let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      return { status: response.status, body: payload };
    };
    const fixtures = JSON.parse(readFileSync(new URL('../../services/auth-service/exploration/contract/api-fixtures.json', import.meta.url)));
    const command = structuredClone(fixtures.httpCases.find(c => c.name === 'pickup-delayed-first-claim-C1-after-C2').request.body);
    const pickup = (body = command, user = 1) => request('/api/auth/explore/pickups', { body, user });
    const nearby = () => request('/api/auth/explore/nearby', { headers: { 'x-user-lat': '12.970968', 'x-user-lng': '77.59191' } });
    const collection = user => request('/api/auth/explore/collection', { user });
    const flag = enabled => db.appVersionSetting.upsert({ where: { id: 1 },
      create: { id: 1, config: { features: { exploreFoodFinds: { enabled } } } }, update: { config: { features: { exploreFoodFinds: { enabled } } } } });
    for (let id = 1; id <= 40; id++) await db.user.create({ data: { id, role: 'customer', type: 'general' } });
    await flag(true);
    await bookingDb.booking.create({ data: { customerId: 1, gymId: 101, date: '2026-10-19', startTime: '09:00', endTime: '10:00', amount: 0,
      attendedAt: new Date('2026-10-18T19:00:00Z') } });
    await bookingDb.memberAttendance.createMany({ data: [
      { customerId: 1, gymId: 101, date: '2026-10-19', checkedInAt: new Date('2026-10-19T03:30:00Z') },
      { customerId: 1, gymId: 101, date: '2026-10-20', checkedInAt: new Date('2026-10-20T03:30:00Z') },
      { customerId: 2, gymId: 999, date: '2026-10-19' },
    ] });
    await bookingDb.independentCheckIn.create({ data: { customerId: 1, unclaimedGymId: 101, date: '2026-10-19' } });
    const snapshot = async () => {
      const tables = (await sql.query(`SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('auth','booking')
        AND tablename NOT LIKE 'Explore%' AND tablename <> 'AppVersionSetting' ORDER BY schemaname,tablename`)).rows;
      const result = {};
      for (const { schemaname, tablename } of tables) {
        const ident = value => '"' + value.replaceAll('"', '""') + '"';
        result[`${schemaname}.${tablename}`] = (await sql.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${ident(schemaname)}.${ident(tablename)} t`)).rows[0].rows;
      }
      return result;
    };
    const before = await snapshot();

    await t.test('real JWT enforcement, role gates, spoof stripping and empty account', async () => {
      for (const bearer of [null, 'invalid', token(1, 'customer', { exp: 1 })]) {
        const response = await request('/api/auth/explore/collection', { bearer, headers: { 'x-user-id': '1', 'x-user-role': 'customer' } });
        assert.equal(response.status, 401); assert.equal(response.body.error.code, 'AUTH_REQUIRED');
      }
      assert.equal((await collection(1)).body.data.summary.savedFindCount, 0);
      assert.equal((await request('/api/auth/explore/collection', { role: 'partner' })).status, 403);
      assert.equal((await request('/api/bookings/mine/visited-gyms', { bearer: null })).status, 401);
    });
    await t.test('native concurrent cold publishers with distinct candidate catalogues return one immutable winner', async () => {
      const a = realExploreService({ db, currentCatalogue: () => catalogueV1 });
      const b = realExploreService({ db, currentCatalogue: () => fixtures.futureCatalogue });
      const winners = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? a : b).publish('20261021')));
      assert.ok(winners.every(m => JSON.stringify(m) === JSON.stringify(winners[0])));
      assert.equal(await db.exploreEpochManifest.count({ where: { epoch: '20261021' } }), 1);
      await assert.rejects(db.exploreEpochManifest.update({ where: { epochManifestId: winners[0].epochManifestId }, data: { payload: {} } }));
      await assert.rejects(db.exploreCatalogue.delete({ where: { version: winners[0].catalogueVersion } }));
    });
    let original;
    await t.test('real nearby publication and next-window rotation', async () => {
      const first = await nearby(); assert.equal(first.status, 200); original = first.body.data;
      assert.equal(original.currentWindow, 1); assert.ok(original.occurrences.length > 0);
      timestamp = '2026-10-19T05:31:00Z';
      const next = await nearby(); assert.equal(next.status, 200); assert.equal(next.body.data.currentWindow, 2);
      assert.notDeepEqual(next.body.data.occurrences.map(o => o.occurrenceId), original.occurrences.map(o => o.occurrenceId));
    });
    let receipt;
    await t.test('delayed FIRST claim after C2 publication retains M1/C1 item', async () => {
      assert.equal(await db.exploreLocationReceipt.count(), 0);
      currentCatalogue = fixtures.futureCatalogue; timestamp = '2026-10-20T01:30:00Z';
      assert.equal((await nearby()).body.data.manifest.catalogueVersion, currentCatalogue.catalogueVersion);
      const response = await pickup(); assert.equal(response.status, 200); assert.equal(response.body.data.result, 'saved');
      receipt = response.body.data.receipt;
      const expected = resolveGrid(parseOccurrence(command.occurrenceId), original.manifest, catalogueV1);
      assert.equal(receipt.itemKey, expected.pick.itemKey); assert.equal(receipt.catalogueVersion, 1);
      const scenario = fixtures.scenarios.find(s => s.name === 'offline-first-claim-after-catalogue-and-config-change');
      assert.notEqual(receipt.itemKey, scenario.incorrectLatestRecomputedItemKey);
    });
    await t.test('concurrent same/different command IDs yield one receipt/revision, account isolation and conflict', async () => {
      const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => pickup({ ...command, claimId: i % 2 ? command.claimId : `parallel-${i}` })));
      for (const response of responses) { assert.equal(response.status, 200); assert.equal(response.body.data.receipt.receiptId, receipt.receiptId); }
      assert.equal(await db.exploreLocationReceipt.count({ where: { userId: 1 } }), 1);
      assert.equal((await db.exploreProgress.findUnique({ where: { userId: 1 } })).revision, 1);
      const freshRace = await Promise.all(Array.from({ length: 12 }, (_, i) => pickup({ ...command, claimId: i < 6 ? 'same-cold-claim' : `cold-${i}` }, 3)));
      assert.equal(freshRace.filter(r => r.body.data?.result === 'saved').length, 1);
      assert.equal(new Set(freshRace.map(r => r.body.data.receipt.receiptId)).size, 1);
      const conflict = await pickup({ ...command, position: { ...command.position, accuracyMeters: 29 } });
      assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal((await collection(2)).body.data.summary.savedFindCount, 0);
      const second = await pickup(command, 2); assert.equal(second.body.data.result, 'saved');
      assert.notEqual(second.body.data.receipt.receiptId, receipt.receiptId);
      const spoofed = await request('/api/auth/explore/collection', { user: 4, headers: { 'x-user-id': '1', 'x-user-role': 'customer' } });
      assert.equal(spoofed.body.data.summary.savedFindCount, 0);
    });
    await t.test('real HTTP timeout after DB commit replays original receipt once', async () => {
      holdAfterCommit = true;
      try {
        await assert.rejects(fetch(base + '/api/auth/explore/pickups', {
          method: 'POST', signal: AbortSignal.timeout(1000),
          headers: { authorization: `Bearer ${token(5)}`, 'content-type': 'application/json' }, body: JSON.stringify(command),
        }), error => error.name === 'TimeoutError');
        assert.equal(typeof releaseHeldResponse, 'function', 'timeout must follow committed save, not precede it');
      } finally { holdAfterCommit = false; releaseHeldResponse?.(); releaseHeldResponse = undefined; }
      const stored = await db.exploreLocationReceipt.findFirst({ where: { userId: 5 } }); assert.ok(stored);
      const retry = await pickup(command, 5); assert.equal(retry.body.data.result, 'already_saved');
      assert.equal(retry.body.data.receipt.receiptId, stored.receiptId);
      assert.deepEqual(retry.body.data.delta.addedReceiptIds, []);
      assert.equal((await db.exploreProgress.findUnique({ where: { userId: 5 } })).revision, 1);
    });
    await t.test('HTTP window, freshness, speed, accuracy, encounter and inclusive grace boundaries', async () => {
      const bounds = windowBounds('20261019', 1);
      const end = bounds.end;
      const cases = [
        { user: 10, now: '2026-10-19T05:31:00Z', change: {}, reason: null },
        { user: 11, now: '2026-10-19T05:31:00Z', change: { startedAt: '2026-10-19T05:30:00Z', completedAt: '2026-10-19T05:30:30Z' }, reason: 'START_OUTSIDE_WINDOW' },
        { user: 12, now: '2026-10-19T05:31:10Z', change: { completedAt: '2026-10-19T05:30:45Z' }, reason: 'ENCOUNTER_TOO_LONG' },
        { user: 13, now: new Date(end + 86400000).toISOString(), change: {}, reason: null },
        { user: 14, now: new Date(end + 86400001).toISOString(), change: {}, reason: 'UPLOAD_EXPIRED' },
        { user: 15, now: '2026-10-19T05:31:00Z', proof: { accuracyMeters: 30.001 }, reason: 'FIX_INACCURATE' },
        { user: 16, now: '2026-10-19T05:31:00Z', proof: { speedMetersPerSecond: 4.001 }, reason: 'MOVING_TOO_FAST' },
        { user: 17, now: '2026-10-19T05:31:00Z', proof: { fixAt: new Date(Date.parse(command.startedAt) - 30001).toISOString() }, reason: 'FIX_STALE' },
        { user: 18, now: '2026-10-19T05:31:00Z', proof: { accuracyMeters: 30, speedMetersPerSecond: 4,
          fixAt: new Date(Date.parse(command.startedAt) - 30000).toISOString() }, reason: null },
        { user: 19, now: '2026-10-19T05:31:00Z', change: { completedAt: new Date(Date.parse(command.startedAt) + 60000).toISOString() }, reason: null },
        { user: 20, now: '2026-10-19T05:31:00Z', proof: { latitude: 0, longitude: 0 }, reason: 'OUTSIDE_GEOFENCE' },
      ];
      for (const c of cases) {
        timestamp = c.now;
        const response = await pickup({ ...command, ...c.change, position: { ...command.position,
          ...(c.change?.startedAt ? { capturedAt: c.change.startedAt } : {}), ...c.proof } }, c.user);
        assert.equal(response.status, 200, JSON.stringify(c));
        assert.equal(response.body.data.reason?.code ?? null, c.reason, JSON.stringify(c));
      }
    });
    await t.test('native transaction failure leaves no partial receipt/progress/claim', async () => {
      timestamp = '2026-10-20T01:30:00Z';
      await sql.query(`CREATE FUNCTION auth.e10_fail_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."userId" = 30 THEN RAISE EXCEPTION 'injected local failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER e10_fail_claim BEFORE INSERT ON auth."ExploreClaim" FOR EACH ROW EXECUTE FUNCTION auth.e10_fail_claim()`);
      try {
        assert.equal((await pickup(command, 30)).status, 503);
        assert.equal(await db.exploreLocationReceipt.count({ where: { userId: 30 } }), 0);
        assert.equal(await db.exploreProgress.count({ where: { userId: 30 } }), 0);
      } finally { await sql.query('DROP TRIGGER e10_fail_claim ON auth."ExploreClaim"; DROP FUNCTION auth.e10_fail_claim()'); }
    });
    await t.test('native uniqueness/FK/immutability and snapshot pagination under a concurrent insert', async () => {
      timestamp = '2026-10-20T01:30:00Z';
      const makeCommand = slot => {
        const parsed = { ...parseOccurrence(command.occurrenceId), slot };
        const spawn = resolveGrid(parsed, original.manifest, catalogueV1);
        return { ...command, claimId: `page-${slot}`, occurrenceId: spawn.occurrenceId,
          position: { ...command.position, latitude: spawn.latitude, longitude: spawn.longitude } };
      };
      await pickup(makeCommand(0), 34); await pickup(makeCommand(1), 34);
      const first = await request('/api/auth/explore/collection?limit=1', { user: 34 });
      const cursor = first.body.data.nextCursor; assert.ok(cursor);
      await pickup(makeCommand(2), 34);
      const second = await request(`/api/auth/explore/collection?limit=1&cursor=${encodeURIComponent(cursor)}`, { user: 34 });
      assert.equal(second.body.data.summary.savedFindCount, 2); assert.equal(second.body.data.nextCursor, null);
      assert.notEqual(first.body.data.history[0].receiptId, second.body.data.history[0].receiptId);
      assert.equal((await request(`/api/auth/explore/collection?cursor=${encodeURIComponent(cursor)}`, { user: 35 })).status, 400);
      const row = await db.exploreLocationReceipt.findFirst({ where: { userId: 34 } });
      await assert.rejects(db.exploreLocationReceipt.create({ data: { ...row, receiptId: 'duplicate-occurrence', revision: 99 } }));
      await assert.rejects(db.exploreLocationReceipt.update({ where: { receiptId: row.receiptId }, data: { payload: {} } }));
      await assert.rejects(db.exploreProgress.create({ data: { userId: 99999 } }));
      await assert.rejects(db.exploreClaim.create({ data: { userId: 35, claimId: 'invalid-terminal', fingerprint: 'local-only' } }));
    });
    await t.test('mixed-source venue recognition, IST-day dedup, namespace collision, missing metadata and account filter', async () => {
      const v2 = await request('/api/bookings/mine/visited-gyms?version=2'); assert.equal(v2.status, 200);
      assert.deepEqual(v2.body.data.map(r => [r.venueId, r.visitCount]), [['partner:101', 2], ['unclaimed:101', 1]]);
      assert.equal(v2.body.data[1].gym, null);
      const v1 = await request('/api/bookings/mine/visited-gyms'); assert.equal(v1.body.data.length, 1);
      assert.equal(v1.body.data[0].visitCount, 2); assert.ok(!Object.hasOwn(v1.body.data[0], 'venueId'));
      assert.equal((await request('/api/bookings/mine/visited-gyms?version=3')).status, 400);
      assert.deepEqual((await request('/api/bookings/mine/visited-gyms?version=2', { user: 4 })).body.data, []);
    });
    await t.test('flag-off rollback keeps receipts/history and resolves pending original-manifest claims', async () => {
      timestamp = '2026-10-20T01:30:00Z'; await flag(false);
      const count = await db.exploreEpochManifest.count();
      assert.equal((await nearby()).status, 404);
      assert.equal((await collection(1)).body.data.history[0].receiptId, receipt.receiptId);
      assert.equal((await request(`/api/auth/explore/catalogue?version=1&hash=${catalogueV1.contentHash}`)).status, 200);
      const pending = await pickup(command, 31); assert.equal(pending.body.data.result, 'saved');
      timestamp = '2026-10-25T00:00:00Z';
      const replay = await pickup(command, 31); assert.equal(replay.body.data.result, 'already_saved');
      const expired = await pickup(command, 32); assert.equal(expired.body.data.reason.code, 'UPLOAD_EXPIRED');
      const unpublished = await pickup({ ...command, epochManifestId: 'never-published' }, 33);
      assert.equal(unpublished.body.error.code, 'MANIFEST_UNPUBLISHED');
      assert.equal(await db.exploreEpochManifest.count(), count);
      await flag(true);
      assert.equal((await collection(31)).body.data.history[0].receiptId, pending.body.data.receipt.receiptId);
      assert.equal((await sql.query(`SELECT to_regclass('auth."CollectibleFind"') AS old`)).rows[0].old, null);
    });
    await t.test('all non-Explore auth/booking tables unchanged, no downstream mutation calls', async () => {
      assert.deepEqual(await snapshot(), before);
      assert.ok(downstream.every(call => call.method === 'GET' && call.path.startsWith('/internal/')));
    });
    await t.test('legacy endpoints absent; real account export/deletion retains other accounts and global manifests', async () => {
      for (const method of ['GET', 'POST']) assert.equal((await request('/api/auth/collectibles', { method, body: method === 'POST' ? {} : undefined })).status, 404);
      const { buildFullExportService } = await import('../../services/auth-service/services/exportService.js');
      const { deleteUserService } = await import('../../services/auth-service/services/authService.js');
      // A reserved reward receipt is seeded only to exercise both export/erasure classes; no B1 issuance claim.
      const reward = { ...fixtures.rewardExamples[0], receiptId: 'e10-export-reward' };
      await db.exploreRewardReceipt.create({ data: { userId: 1, receiptId: reward.receiptId, rewardKey: reward.rewardKey,
        revision: 2, acknowledgedAt: new Date(reward.acknowledgedAt), payload: reward } });
      await db.exploreProgress.update({ where: { userId: 1 }, data: { revision: 2 } });
      const exported = await buildFullExportService(1);
      assert.equal(exported.exploration.locationReceipts[0].receiptId, receipt.receiptId);
      assert.equal(exported.exploration.rewardReceipts[0].receiptId, reward.receiptId);
      assert.ok(!Object.hasOwn(exported, 'collectiblesFound'));
      for (const key of ['position', 'fixAt', 'capturedAt', 'fingerprint']) assert.ok(!JSON.stringify(exported.exploration).includes(key));
      const globals = await db.exploreEpochManifest.count(); const other = (await collection(2)).body.data;
      await deleteUserService(1);
      for (const model of ['exploreClaim', 'exploreLocationReceipt', 'exploreRewardReceipt', 'exploreProgress']) assert.equal(await db[model].count({ where: { userId: 1 } }), 0);
      assert.equal(await db.user.count({ where: { id: 1 } }), 0);
      assert.deepEqual((await collection(2)).body.data, other);
      assert.equal(await db.exploreEpochManifest.count(), globals);
    });
  } finally {
    await Promise.all(servers.map(server => new Promise(r => server.close(r))));
    await Promise.all([db.$disconnect(), bookingDb.$disconnect(), sql.end()]);
  }
});
