import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryDb } from './exploreMemoryDb.js';
import { createExploreService } from '../exploration/service.js';
import { deliverPickupBatch, pickupProperties } from '../exploration/telemetry.js';
import { insertReceiptEvent, deliverReceiptEvent } from '../utils/analytics.js';
const fixtures=JSON.parse(readFileSync(new URL('../exploration/contract/api-fixtures.json',import.meta.url),'utf8'));
const saved=fixtures.httpCases.find(c=>c.name==='pickup-delayed-first-claim-C1-after-C2');
const command=saved.request.body, receipt=saved.response.body.data.receipt;
async function setup() {
  const db=memoryDb();
  const manifest=fixtures.manifests[0];
  await db.exploreEpochManifest.create({data:{epochManifestId:manifest.epochManifestId,payload:manifest}});
  const service=createExploreService({db,now:()=>receipt.acknowledgedAt,cursorSecret:'test',fingerprintSecret:'test'});
  return {db,service};
}
test('concurrent same/different claims, lost reply and late retry create one canonical saved event',async()=>{
  const {db,service}=await setup();
  const results=await Promise.all(Array.from({length:20},(_,i)=>service.pickup(1,{...command,claimId:i<10?command.claimId:`claim-${i}`})));
  assert.equal(results.filter(r=>r.result==='saved').length,1);
  assert.equal(new Set(results.map(r=>r.receipt.receiptId)).size,1);
  await service.pickup(1,command); // discard first reply, retry same command
  const late=createExploreService({db,now:()=> '2027-01-01T00:00:00Z',cursorSecret:'test',fingerprintSecret:'test'});
  assert.equal((await late.pickup(1,{...command,claimId:'late-claim'})).result,'already_saved');
  assert.equal(db.inspect().exploreReceiptEvent.length,1);
  const row=db.inspect().exploreReceiptEvent[0];
  assert.equal(row.receiptId,results[0].receipt.receiptId);
  assert.equal(row.claimId,null);
  assert.deepEqual(row.properties,{source:'location',occurrence_kind:'grid',duration_bucket:'10s_to_1m'});
  await assert.rejects(service.pickup(1,{...command,completedAt:command.startedAt}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  assert.equal(db.inspect().exploreReceiptEvent.length,1);
  await service.pickup(2,command);
  assert.equal(db.inspect().exploreReceiptEvent.length,2);
});
test('terminal rejection is once per claim, including exact concurrent replay',async()=>{
  const {db,service}=await setup();
  const bad={...command,position:{...command.position,accuracyMeters:100}};
  await Promise.all(Array.from({length:10},()=>service.pickup(1,bad)));
  await service.pickup(1,{...bad,claimId:'other-rejected-claim'});
  const rows=db.inspect().exploreReceiptEvent;
  assert.equal(rows.length,2);
  for(const row of rows) {
    assert.equal(row.event,'explore_pickup_rejected');
    assert.deepEqual(row.properties,{source:'location',occurrence_kind:'grid',reason:'FIX_INACCURATE'});
  }
  await service.pickup(1,{...command,claimId:'unknown',occurrenceId:'unknown'});
  assert.equal(db.inspect().exploreReceiptEvent[2].properties.occurrence_kind,null);
});
test('retryable errors and malformed commands do not create outcomes',async()=>{
  const {db,service}=await setup();
  await assert.rejects(service.pickup(1,{...command,epochManifestId:'missing'}));
  await assert.rejects(service.pickup(1,{}));
  assert.equal(db.inspect().exploreReceiptEvent.length,0);
});
test('outbox failure rolls back receipt, revision and claim; claim failure creates no event',async()=>{
  for(const failed of ['exploreReceiptEvent','exploreClaim']) {
    const {db,service}=await setup(); db.failNext(failed);
    await assert.rejects(service.pickup(1,command));
    const rows=db.inspect();
    for(const name of ['exploreReceiptEvent','exploreClaim','exploreProgress','exploreLocationReceipt']) assert.equal(rows[name].length,0);
    await service.pickup(1,command);
    assert.equal(db.inspect().exploreReceiptEvent.length,1);
  }
  const {db,service}=await setup();db.failNext('exploreReceiptEvent');
  await assert.rejects(service.pickup(1,{...command,occurrenceId:'unknown'}));
  assert.equal(db.inspect().exploreClaim.length,0);
});
test('delivery failure persists a retry, does not alter receipt, and succeeds later',async()=>{
  const {db,service}=await setup(); await service.pickup(1,command);
  const before=db.inspect().exploreLocationReceipt;
  assert.equal(await deliverPickupBatch({db,send:async()=>{throw new Error('offline');},limit:1}),0);
  const row=db.inspect().exploreReceiptEvent[0];
  assert.equal(row.attempts,1);assert.ok(!row.deliveredAt);assert.ok(row.nextAttemptAt>new Date());
  await db.exploreReceiptEvent.update({where:{eventId:row.eventId},data:{nextAttemptAt:new Date(0)}});
  const received=[];
  assert.equal(await deliverPickupBatch({db,send:async r=>received.push(r)}),1);
  assert.equal(await deliverPickupBatch({db,send:async r=>received.push(r)}),0);
  assert.equal(received.length,1);
  assert.deepEqual(db.inspect().exploreLocationReceipt,before);
});

// SQL-contract substitute: evaluates INSERT ... WHERE NOT EXISTS and models
// transaction advisory lock serialization. Native PostgreSQL has a separate gate.
function sinkDb() {
  const rows=[];let tail=Promise.resolve();
  return {rows,async connect(){let releaseLock;let snapshot;
    return {async query(sql,args){
      if(sql==='BEGIN ISOLATION LEVEL READ COMMITTED') return;
      if(sql.includes('pg_advisory_xact_lock')) {const before=tail;tail=new Promise(r=>{releaseLock=r;});await before;snapshot=structuredClone(rows);return;}
      if(sql.includes('INSERT INTO analytics_events')) {
        assert.match(sql,/WHERE NOT EXISTS/);assert.match(sql,/properties->>'_delivery_id' = \$5/);
        assert.match(sql,/source = 'server' AND service = 'auth-service'/);
        if(!rows.some(r=>r.properties._delivery_id===args[4])) rows.push({event:args[0],distinctId:args[1],properties:JSON.parse(args[2])});return;
      }
      if(sql==='ROLLBACK') rows.splice(0,rows.length,...snapshot);
      if(sql==='COMMIT'||sql==='ROLLBACK') {releaseLock?.();return;}
      assert.fail(sql);
    },release(){}};
  }};
}
test('sink deduplicates repeated/concurrent sends and the sink-commit/local-ack crash window',async()=>{
  const {db,service}=await setup();await service.pickup(1,command);
  const sink=sinkDb(),row=db.inspect().exploreReceiptEvent[0];
  await Promise.all(Array.from({length:10},()=>insertReceiptEvent(sink,row)));
  assert.equal(sink.rows.length,1);
  db.failNext('exploreReceiptEventUpdate');
  await assert.rejects(deliverPickupBatch({db,send:r=>insertReceiptEvent(sink,r)}));
  assert.ok(!db.inspect().exploreReceiptEvent[0].deliveredAt);
  await deliverPickupBatch({db,send:r=>insertReceiptEvent(sink,r)});
  assert.equal(sink.rows.length,1);
  assert.ok(db.inspect().exploreReceiptEvent[0].deliveredAt);
  assert.deepEqual(Object.keys(sink.rows[0].properties).sort(),['_delivery_id','duration_bucket','occurrence_kind','source']);
});
test('payload projection excludes command IDs, proof, exact times and arbitrary food/medical fields',()=>{
  const properties=pickupProperties({command:{...command,food:'sensitive',medical:'sensitive'},receipt:{...receipt,medical:'sensitive'}});
  assert.deepEqual(Object.keys(properties).sort(),['duration_bucket','occurrence_kind','source']);
  const json=JSON.stringify(properties);
  for(const value of [command.claimId,command.occurrenceId,receipt.receiptId,command.startedAt,'sensitive','latitude','longitude','fingerprint','position']) assert.ok(!json.includes(value));
  for(const [seconds,bucket] of [[0,'under_10s'],[10,'10s_to_1m'],[60,'1m_to_5m'],[300,'5m_to_15m'],[900,'15m_plus']]) {
    assert.equal(pickupProperties({receipt:{startedAt:'2026-01-01T00:00:00Z',completedAt:new Date(Date.parse('2026-01-01T00:00:00Z')+seconds*1000).toISOString()}}).duration_bucket,bucket);
  }
});
test('concurrent delivery workers acknowledge one pending event',async()=>{
  const {db,service}=await setup();await service.pickup(1,command);
  const sent=[];
  await Promise.all(Array.from({length:5},()=>deliverPickupBatch({db,send:async row=>sent.push(row.eventId)})));
  assert.equal(sent.length,1);
  assert.ok(db.inspect().exploreReceiptEvent[0].deliveredAt);
});
test('default none provider cannot acknowledge durable delivery',async()=>{
  if(!process.env.ANALYTICS_PROVIDER || process.env.ANALYTICS_PROVIDER==='none') await assert.rejects(deliverReceiptEvent({}));
});
