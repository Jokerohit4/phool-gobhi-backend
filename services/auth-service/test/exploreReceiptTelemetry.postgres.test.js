import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { insertReceiptEvent } from '../utils/analytics.js';

// Explicit disposable LOCAL database only. No inherited DATABASE_URL is used.
const url=process.env.EXPLORE_TELEMETRY_TEST_DATABASE_URL;
test('native PostgreSQL: forward DDL, rollback, uniqueness, cascade and concurrent sink replay', {skip:!url},async t=>{
  const parsed=new URL(url);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'loopback database required');
  assert.match(parsed.pathname,/^\/explore_telemetry_test[a-z0-9_]*$/,'dedicated disposable database required');
  const {default:pg}=await import('pg');
  const schema='receipt_test_'+randomUUID().replaceAll('-','');
  assert.match(schema,/^receipt_test_[a-f0-9]{32}$/);
  const admin=new pg.Pool({connectionString:url,max:1});
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});
    await pool.query('CREATE TABLE "User" ("id" INTEGER PRIMARY KEY)');
    const sql=readFileSync(new URL('../prisma/migrations/20261023170000_explore_receipt_telemetry/migration.sql',import.meta.url),'utf8').replaceAll('"auth".',`"${schema}".`);
    await pool.query(sql);
    await pool.query('INSERT INTO "User" VALUES (1), (2)');
    const put=(client,eventId,userId,receiptId,claimId,event)=>client.query(`INSERT INTO "ExploreReceiptEvent" ("eventId","userId","receiptId","claimId","event","properties") VALUES ($1,$2,$3,$4,$5,'{}')`,[eventId,userId,receiptId,claimId,event]);
    await t.test('native concurrent receipt and rejected-claim unique constraints',async()=>{
      for(const [receiptId,claimId,event] of [['receipt',null,'explore_pickup_saved'],[null,'claim','explore_pickup_rejected']]) {
        const results=await Promise.allSettled(Array.from({length:8},()=>put(pool,randomUUID(),1,receiptId,claimId,event)));
        assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
        assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='23505'));
      }
      await put(pool,randomUUID(),2,null,'claim','explore_pickup_rejected');
      await assert.rejects(put(pool,randomUUID(),1,null,null,'explore_pickup_saved'),e=>e.code==='23514');
    });
    await t.test('rollback removes event and account deletion cascades',async()=>{
      const client=await pool.connect(),eventId=randomUUID();
      try {
        await client.query('BEGIN');await put(client,eventId,1,'rolled-back',null,'explore_pickup_saved');await client.query('ROLLBACK');
      } finally {client.release();}
      assert.equal((await pool.query('SELECT * FROM "ExploreReceiptEvent" WHERE "eventId"=$1',[eventId])).rowCount,0);
      await pool.query('DELETE FROM "User" WHERE id=2');
      assert.equal((await pool.query('SELECT * FROM "ExploreReceiptEvent" WHERE "userId"=2')).rowCount,0);
    });
    await pool.query(`CREATE TABLE analytics_events (event TEXT, distinct_id TEXT, properties JSONB, source TEXT, service TEXT, ts TIMESTAMPTZ)`);
    await t.test('actual sink SQL: concurrent delivery and lost acknowledgement insert one row',async()=>{
      const row={eventId:randomUUID(),userId:1,event:'explore_pickup_saved',properties:{source:'location',occurrence_kind:'grid',duration_bucket:'10s_to_1m'},createdAt:new Date()};
      await Promise.all(Array.from({length:24},()=>insertReceiptEvent(pool,row)));
      await insertReceiptEvent(pool,row); // sink committed, local acknowledgement was lost
      assert.equal((await pool.query('SELECT * FROM analytics_events')).rowCount,1);
      await insertReceiptEvent(pool,{...row,eventId:randomUUID()});
      assert.equal((await pool.query('SELECT * FROM analytics_events')).rowCount,2);
    });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
