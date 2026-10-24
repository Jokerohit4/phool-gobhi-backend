// Hosted-only native cases. Imported before router analytics mocks: these are production functions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { deliverPickupBatch } from '../../services/auth-service/exploration/telemetry.js';
import { insertReceiptEvent } from '../../services/auth-service/utils/analytics.js';

const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native ordering barrier timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}

export async function verifyReceiptTelemetry({ t, db, workerDb, sql, uri, pickup, command, setTime, exportUser, deleteUser }) {
  const sinkUri = new URL(process.env.E10_SINK_DATABASE_URL);
  assert.equal(sinkUri.hostname, '127.0.0.1');
  assert.equal(sinkUri.pathname, '/e10_sink');
  assert.equal(sinkUri.port, uri.port);
  assert.equal(sinkUri.username, uri.username);
  assert.equal(sinkUri.password, uri.password);
  const sink = new pg.Pool({ connectionString: sinkUri.href, max: 8 });
  const checks = [];
  let completed = false;
  const check = (name, fn) => t.test(name, async () => {
    try { await fn(); checks.push({ check: name, result: 'passed' }); }
    catch (error) { checks.push({ check: name, result: 'failed' }); throw error; }
  });
  const events = userId => db.exploreReceiptEvent.findMany({ where: { userId }, orderBy: { eventId: 'asc' } });
  const sinkRows = eventId => sink.query("SELECT * FROM analytics_events WHERE properties->>'_delivery_id'=$1", [eventId]);
  const send = row => insertReceiptEvent(sink, row);
  const deliver = (options = {}) => deliverPickupBatch({ db, send, ...options });
  const due = eventId => db.exploreReceiptEvent.update({ where: { eventId }, data: { nextAttemptAt: new Date(0) } });
  setTime('2026-10-20T01:30:00Z');
  try {
    // Local sink table fixture matches production columns. Provider selection/TLS/ensureTable
    // and the interval scheduler are not exercised; dispatcher and insert SQL are unmodified.
    await sink.query(`CREATE TABLE IF NOT EXISTS analytics_events (
      id BIGSERIAL PRIMARY KEY, event TEXT NOT NULL, distinct_id TEXT,
      properties JSONB NOT NULL DEFAULT '{}', source TEXT, service TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await sink.query('TRUNCATE analytics_events RESTART IDENTITY');

    await check('telemetry: separate auth/sink backends and stronger sink default isolation', async () => {
      const auth = (await sql.query('SELECT current_database() AS db, pg_backend_pid() AS pid')).rows[0];
      const remote = (await sink.query('SELECT current_database() AS db, pg_backend_pid() AS pid')).rows[0];
      assert.notEqual(auth.db, remote.db); assert.notEqual(auth.pid, remote.pid);
      assert.equal((await sink.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation, 'repeatable read');
      const [a, b] = await Promise.all([db.$queryRaw`SELECT pg_backend_pid() AS pid`, workerDb.$queryRaw`SELECT pg_backend_pid() AS pid`]);
      assert.notEqual(a[0].pid, b[0].pid);
    });

    await check('telemetry: native HTTP save/reject races, exact/different-claim replays and privacy', async () => {
      const saved = await Promise.all(Array.from({ length: 16 }, (_, i) => pickup({ ...command, claimId: i < 8 ? 'telemetry-save' : `telemetry-save-${i}` }, 21)));
      assert.equal(saved.filter(r => r.body.data?.result === 'saved').length, 1);
      assert.ok(saved.every(r => r.status === 200 && r.body.data.receipt));
      assert.equal(new Set(saved.map(r => r.body.data.receipt.receiptId)).size, 1);
      const [row] = await events(21); assert.ok(row); assert.equal((await events(21)).length, 1);
      assert.equal(row.receiptId, saved[0].body.data.receipt.receiptId);
      assert.equal(await db.exploreLocationReceipt.count({ where: { userId: 21 } }), 1);
      assert.equal(await db.exploreClaim.count({ where: { userId: 21 } }), 9);
      assert.equal(row.event, 'explore_pickup_saved'); assert.equal(row.claimId, null);
      assert.deepEqual(row.properties, { source: 'location', occurrence_kind: 'grid', duration_bucket: '10s_to_1m' });
      assert.equal((await db.exploreProgress.findUnique({ where: { userId: 21 } })).revision, 1);
      setTime('2026-10-25T00:00:00Z');
      assert.equal((await pickup({ ...command, claimId: 'telemetry-save' }, 21)).body.data.result, 'already_saved');
      assert.equal((await events(21)).length, 1); setTime('2026-10-20T01:30:00Z');
      const rejected = { ...command, claimId: 'telemetry-reject', position: { ...command.position, accuracyMeters: 31 } };
      const responses = await Promise.all(Array.from({ length: 12 }, () => pickup(rejected, 22)));
      assert.ok(responses.every(r => r.status === 200 && r.body.data.reason.code === 'FIX_INACCURATE'));
      assert.equal((await events(22)).length, 1);
      await pickup({ ...rejected, claimId: 'telemetry-reject-distinct' }, 22);
      assert.equal((await events(22)).length, 2);
      assert.ok((await events(22)).every(r => r.receiptId === null && r.event === 'explore_pickup_rejected'));
      assert.deepEqual((await events(22))[0].properties, { source: 'location', occurrence_kind: 'grid', reason: 'FIX_INACCURATE' });
      assert.equal(await db.exploreLocationReceipt.count({ where: { userId: 22 } }), 0);
      assert.equal((await db.exploreProgress.findUnique({ where: { userId: 22 } })).revision, 0);
      assert.equal((await pickup({ ...command, claimId: 'telemetry-save', position: { ...command.position, accuracyMeters: 29 } }, 21)).status, 409);
      assert.equal((await pickup({}, 25)).status, 400);
      assert.equal((await pickup({ ...command, epochManifestId: 'unpublished-telemetry' }, 25)).body.error.code, 'MANIFEST_UNPUBLISHED');
      assert.equal((await events(25)).length, 0); assert.equal((await events(21)).length, 1);
      assert.equal((await sink.query('SELECT * FROM analytics_events')).rowCount, 0, 'pickup must not synchronously send');
      const clone = (eventId, sourceId) => sql.query(`INSERT INTO auth."ExploreReceiptEvent"
        ("eventId","userId","receiptId","claimId",event,properties)
        SELECT $1,"userId","receiptId","claimId",event,properties FROM auth."ExploreReceiptEvent" WHERE "eventId"=$2`, [eventId, sourceId]);
      await assert.rejects(clone(randomUUID(), row.eventId), error => error.code === '23505');
      const rejectRow = (await events(22))[0];
      await assert.rejects(clone(randomUUID(), rejectRow.eventId), error => error.code === '23505');
      await assert.rejects(sql.query(`INSERT INTO auth."ExploreReceiptEvent" ("eventId","userId",event,properties)
        VALUES ($1,21,'explore_pickup_saved','{}')`, [randomUUID()]), error => error.code === '23514');
    });

    await check('telemetry: native outbox insert failure rolls back saved and rejected transactions', async () => {
      await sql.query(`CREATE FUNCTION auth.e10_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."userId" IN (23,24) THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER e10_fail_outbox BEFORE INSERT ON auth."ExploreReceiptEvent" FOR EACH ROW EXECUTE FUNCTION auth.e10_fail_outbox()`);
      try {
        const responses = [];
        for (const user of [23, 24]) {
          const body = user === 23 ? command : { ...command, position: { ...command.position, accuracyMeters: 31 } };
          const response = await pickup(body, user);
          responses.push({ user, response });
          for (const model of ['exploreReceiptEvent', 'exploreClaim', 'exploreLocationReceipt', 'exploreProgress']) {
            assert.equal(await db[model].count({ where: { userId: user } }), 0, `${model}/${user}`);
          }
        }
        for (const { user, response } of responses) assert.equal(response.status, 503, `user ${user}: ${response.body.error?.code}`);
      } finally { await sql.query('DROP TRIGGER e10_fail_outbox ON auth."ExploreReceiptEvent"; DROP FUNCTION auth.e10_fail_outbox()'); }
    });

    // Drain prior HTTP cases through the production adapter; these are prospective
    // events only. Migration does not backfill pre-telemetry receipts.
    // HTTP fixtures inject future domain timestamps; explicitly make this disposable
    // backlog due rather than depending on the hosted runner's calendar date.
    await db.exploreReceiptEvent.updateMany({ where: { deliveredAt: null }, data: { nextAttemptAt: new Date(0) } });
    await deliver({ limit: 200 });
    assert.equal(await db.exploreReceiptEvent.count({ where: { deliveredAt: null } }), 0);

    await check('telemetry: actual concurrent sink SQL deduplicates under repeatable-read session default', async () => {
      const row = (await events(21))[0];
      await Promise.all(Array.from({ length: 24 }, () => send(row)));
      const result = await sinkRows(row.eventId); assert.equal(result.rowCount, 1);
      assert.equal(result.rows[0].source, 'server'); assert.equal(result.rows[0].service, 'auth-service');
      assert.deepEqual(result.rows[0].properties, { ...row.properties, _delivery_id: row.eventId });
    });

    await check('telemetry: real sink transaction failure persists backoff, then retries successfully', async () => {
      assert.equal((await pickup(command, 26)).body.data.result, 'saved');
      const [row] = await events(26);
      await sink.query(`CREATE FUNCTION e10_fail_sink() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.distinct_id='26' THEN RAISE EXCEPTION 'injected sink failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER e10_fail_sink BEFORE INSERT ON analytics_events FOR EACH ROW EXECUTE FUNCTION e10_fail_sink()`);
      const before = Date.now();
      try { assert.equal(await deliver({ limit: 1 }), 0); }
      finally { await sink.query('DROP TRIGGER e10_fail_sink ON analytics_events; DROP FUNCTION e10_fail_sink()'); }
      const [pending] = await events(26);
      assert.equal(pending.attempts, 1); assert.equal(pending.deliveredAt, null);
      assert.ok(pending.nextAttemptAt.getTime() >= before + 1000);
      assert.equal((await sinkRows(row.eventId)).rowCount, 0);
      await db.exploreReceiptEvent.update({ where: { eventId: row.eventId }, data: { nextAttemptAt: new Date(Date.now() + 3600000) } });
      assert.equal(await deliver({ limit: 1 }), 0, 'not due yet');
      await due(row.eventId); assert.equal(await deliver({ limit: 1 }), 1);
      assert.equal((await events(26))[0].attempts, 2);
      assert.ok((await events(26))[0].deliveredAt); assert.equal((await sinkRows(row.eventId)).rowCount, 1);
    });

    await check('telemetry: sink commit/lost reply and native local-ack failure replay one sink row', async () => {
      await pickup(command, 27); const [row] = await events(27);
      assert.equal(await deliver({ limit: 1, send: async event => { await send(event); throw new Error('injected lost sink reply after COMMIT'); } }), 0);
      assert.equal((await sinkRows(row.eventId)).rowCount, 1);
      assert.equal((await events(27))[0].deliveredAt, null);
      await due(row.eventId);
      await sql.query(`CREATE FUNCTION auth.e10_fail_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."userId"=27 AND NEW."deliveredAt" IS NOT NULL THEN RAISE EXCEPTION 'injected local ack failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER e10_fail_ack BEFORE UPDATE ON auth."ExploreReceiptEvent" FOR EACH ROW EXECUTE FUNCTION auth.e10_fail_ack()`);
      try { await assert.rejects(deliver({ limit: 1 })); }
      finally { await sql.query('DROP TRIGGER e10_fail_ack ON auth."ExploreReceiptEvent"; DROP FUNCTION auth.e10_fail_ack()'); }
      assert.equal((await events(27))[0].deliveredAt, null); assert.equal((await events(27))[0].attempts, 1);
      assert.equal((await sinkRows(row.eventId)).rowCount, 1);
      assert.equal(await deliver({ limit: 1 }), 1);
      assert.equal((await sinkRows(row.eventId)).rowCount, 1); assert.equal((await events(27))[0].attempts, 2);
    });

    await check('telemetry: separate auth workers skip a locked pending row and deliver each event once', async () => {
      for (const user of [28, 29, 36]) assert.equal((await pickup(command, user)).body.data.result, 'saved');
      const entered = gate(), release = gate(); let held;
      const seen = [];
      const first = deliver({ limit: 1, send: async row => { held = row.eventId; seen.push(held); entered.release(); await release.promise; await send(row); } });
      try {
        await bounded(entered.promise);
        assert.equal(await bounded(deliver({ db: workerDb, limit: 1, send: async row => { assert.notEqual(row.eventId, held); seen.push(row.eventId); await send(row); } })), 1);
      } finally { release.release(); await first; }
      await Promise.all(Array.from({ length: 8 }, (_, i) => deliver({ db: i % 2 ? db : workerDb, limit: 2,
        send: async row => { seen.push(row.eventId); await send(row); } })));
      assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3);
      for (const user of [28, 29, 36]) {
        const [row] = await events(user); assert.equal(row.attempts, 1); assert.ok(row.deliveredAt);
        assert.equal((await sinkRows(row.eventId)).rowCount, 1);
      }
    });

    await check('telemetry: export projection/account scope and dispatcher-before-deletion lock ordering', async () => {
      for (const user of [37, 38, 40]) await pickup(command, user);
      const [row] = await events(37);
      const exported = await exportUser(37);
      assert.equal(exported.exploration.receiptTelemetry.length, 1);
      const record = exported.exploration.receiptTelemetry[0]; assert.equal(record.eventId, row.eventId);
      assert.deepEqual(Object.keys(record).sort(), ['eventId','event','properties','createdAt','deliveredAt','attempts','nextAttemptAt'].sort());
      assert.deepEqual(record.properties, row.properties);
      const other = await events(40); const globals = await db.exploreEpochManifest.count();
      // Guard proves outbox deletion precedes receipt/claim deletion, independent of FK cascade.
      await sql.query(`CREATE FUNCTION auth.e10_assert_event_erased_first() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD."userId" IN (37,38) AND EXISTS (SELECT 1 FROM auth."ExploreReceiptEvent" WHERE "userId"=OLD."userId")
        THEN RAISE EXCEPTION 'outbox must be erased first'; END IF; RETURN OLD; END $$;
        CREATE TRIGGER e10_erasure_receipt BEFORE DELETE ON auth."ExploreLocationReceipt" FOR EACH ROW EXECUTE FUNCTION auth.e10_assert_event_erased_first();
        CREATE TRIGGER e10_erasure_claim BEFORE DELETE ON auth."ExploreClaim" FOR EACH ROW EXECUTE FUNCTION auth.e10_assert_event_erased_first()`);
      // Make only this row due to select the ordering subject deterministically.
      await db.exploreReceiptEvent.updateMany({ where: { userId: { in: [38,40] } }, data: { nextAttemptAt: new Date(Date.now() + 3600000) } });
      const entered = gate(), release = gate(); let deletion;
      const worker = deliver({ limit: 1, send: async event => { assert.equal(event.eventId, row.eventId); entered.release(); await release.promise; await send(event); } });
      try {
        await bounded(entered.promise);
        deletion = deleteUser(37);
        deletion.catch(() => {}); // Awaited below; avoid unhandled rejection while inspecting locks.
        // Observe a real blocked DELETE rather than infer ordering from a sleep.
        await (async () => {
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            const waiting = await sql.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
              AND wait_event_type='Lock' AND query LIKE 'DELETE%ExploreReceiptEvent%'
              AND cardinality(pg_blocking_pids(pid))>0`);
            if (waiting.rowCount) return;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.fail('Expected native dispatcher/deletion lock wait');
        })();
        release.release(); assert.equal(await worker, 1); await deletion;
        assert.equal((await sinkRows(row.eventId)).rowCount, 1);
        assert.equal((await events(37)).length, 0);
        assert.equal(await db.user.count({ where: { id: 37 } }), 0);
        const [removedBeforeSelection] = await events(38);
        await deleteUser(38); await deliver({ limit: 25 });
        assert.equal((await sinkRows(removedBeforeSelection.eventId)).rowCount, 0);
        assert.equal((await events(38)).length, 0);
        // Only scheduling state intentionally changed for account 40.
        const retained = await events(40); assert.equal(retained[0].eventId, other[0].eventId);
        assert.equal(retained[0].deliveredAt, null);
        assert.equal(await db.exploreEpochManifest.count(), globals);
      } finally {
        release.release(); await Promise.allSettled([worker, deletion]);
        await sql.query('DROP TRIGGER e10_erasure_receipt ON auth."ExploreLocationReceipt"; DROP TRIGGER e10_erasure_claim ON auth."ExploreClaim"; DROP FUNCTION auth.e10_assert_event_erased_first()');
      }
    });
    completed = true;
  } finally {
    writeFileSync(new URL(`./.runtime/telemetry-${uri.pathname.slice(1)}.local.json`, import.meta.url), JSON.stringify({
      authDatabase: uri.pathname.slice(1), sinkDatabase: 'e10_sink', plannedChecks: 8, checks,
      result: completed && checks.length === 8 && checks.every(c => c.result === 'passed') ? 'passed' : 'failed-or-incomplete',
      substitutions: ['loopback sink table fixture', 'explicit pg pool bypasses provider/TLS setup', 'injected clock and faults', 'external export/erasure fan-out', 'scheduler not started'],
    }, null, 2) + '\n');
    await sink.end();
  }
}
