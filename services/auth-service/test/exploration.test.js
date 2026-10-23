import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import express from 'express';
import { memoryDb } from './exploreMemoryDb.js';
import { createExploreService } from '../exploration/service.js';
import { catalogueV1, canonical, timingReason, windowBounds, errorResponse, ExploreError, parseOccurrence } from '../exploration/contracts.js';

const fixtures=JSON.parse(readFileSync(new URL('../exploration/contract/api-fixtures.json',import.meta.url),'utf8'));
const [m1,m2]=fixtures.manifests;
const savedCase=fixtures.httpCases.find(c=>c.name==='pickup-delayed-first-claim-C1-after-C2');
const command=savedCase.request.body,receipt=savedCase.response.body.data.receipt;
let createExploreRouter;
test('setup: mock Prisma once and import exploration router',async t=>{
  t.mock.module('@prisma/client',{exports:{PrismaClient:class {},Prisma:{}}});
  ({createExploreRouter}=await import('../exploration/routes.js'));
});
function setup(time=receipt.acknowledgedAt,fingerprintSecret='test-fingerprint-secret') {
  const db=memoryDb();let timestamp=time,serial=0,current=catalogueV1;
  const service=createExploreService({db,now:()=>timestamp,receiptId:()=>serial++===0?receipt.receiptId:`loc-A-${serial}`,cursorSecret:'test-cursor-secret',fingerprintSecret,currentCatalogue:()=>current});
  return {db,service,setTime:t=>{timestamp=t;},setCatalogue:cat=>{current=cat;}};
}
async function bind(s,manifest=m1,cat=catalogueV1) {
  await s.db.exploreCatalogue.createMany({data:[{version:cat.catalogueVersion,hash:cat.contentHash,payload:cat}],skipDuplicates:true});
  await s.db.exploreEpochManifest.createMany({data:[{epochManifestId:manifest.epochManifestId,epoch:manifest.epoch,worldGeneration:manifest.worldGeneration,payload:manifest}],skipDuplicates:true});
}
async function seed(s,items,userId=1) {
  let revision=0;
  for(const payload of items) {
    const model=payload.source==='location'?'exploreLocationReceipt':'exploreRewardReceipt';
    const identity=payload.source==='location'?{occurrenceId:payload.occurrenceId,epochManifestId:payload.epochManifestId}:{rewardKey:payload.rewardKey};
    await s.db[model].create({data:{userId,revision:++revision,receiptId:payload.receiptId,acknowledgedAt:new Date(payload.acknowledgedAt),payload,...identity}});
  }
  await s.db.exploreProgress.createMany({data:[{userId,revision}],skipDuplicates:true});
}
async function http(service,request,headers={}) {
  const app=express();app.use(express.json());app.use('/api/auth/explore',createExploreRouter(service));
  app.use((err,req,res,next)=>errorResponse(res,'INVALID_REQUEST','req-example'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
    const url=new URL(request.path,`http://127.0.0.1:${server.address().port}`);
    for(const [k,v] of Object.entries(request.query??{})) url.searchParams.set(k,String(v));
    const response=await fetch(url,{method:request.method,headers:{'content-type':'application/json','x-user-id':'1','x-user-role':'customer',...request.headers,...headers},body:request.body===null||request.body===undefined?undefined:JSON.stringify(request.body)});
    return {status:response.status,body:await response.json(),retryAfter:response.headers.get('retry-after')};
  } finally {await new Promise(r=>server.close(r));}
}
const normalize=value=>{
  if (Array.isArray(value))return value.map(normalize);
  if (value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='requestId'?'req-example':normalize(v)]));
  return typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)?new Date(value).toISOString():value;
};
for(const c of fixtures.httpCases) {
  const outsideA=c.request.path.endsWith('/today')?'E3-B1 today is outside E3-A':c.request.path.startsWith('/api/bookings/')?'E4 booking-service owns visited-gyms':null;
  test(`api fixture: ${c.name}`,{skip:outsideA??false},async()=>{
    const s=setup();await bind(s);await bind(s,m2,fixtures.futureCatalogue);
    await s.db.appVersionSetting.create({data:{id:1,config:{features:{exploreFoodFinds:{enabled:true}}}}});
    if(c.request.path.endsWith('/nearby'))s.setTime(c.response.body.data?.serverTime??'2026-10-19T05:29:00Z');
    if(c.name==='collection-empty')s.setTime(c.response.body.data.snapshotAt);
    if(c.name==='collection-location')await seed(s,[receipt]);
    if(c.name==='collection-merged-B1')await seed(s,[receipt,fixtures.rewardExamples[0]]);
    if(c.name==='pickup-timeout-replay')await s.service.pickup(1,command);
    const response=await http(s.service,c.request);
    assert.equal(response.status,c.response.status);
    assert.deepEqual(normalize(response.body),normalize(c.response.body));
  });
}
for(const c of fixtures.timingCases)test(`timing fixture: ${c.name}`,()=>{
  assert.equal(timingReason(c,windowBounds('20261019',1)),c.reason);
});
for(const c of fixtures.transportErrorExamples)test(`transport envelope: ${c.code}`,async()=>{
  const service={catalogue:()=>{throw new ExploreError(c.code);}};
  const r=await http(service,{method:'GET',path:'/api/auth/explore/catalogue',body:null});
  assert.equal(r.status,c.status);assert.deepEqual(normalize(r.body),c.body);
  if(c.status===429||c.status===503)assert.equal(r.retryAfter,'5');
});
for(const scenario of fixtures.scenarios) test(`scenario: ${scenario.name}`,async t=>{
  const s=setup();
  switch(scenario.name) {
    case 'concurrent-cold-manifest-publication':
    case 'concurrent-manifest-publication': {
      if(scenario.prepublishedManifest)await bind(s);
      const manifests=await Promise.all([s.service.publish(scenario.epoch),s.service.publish(scenario.epoch)]);
      assert.deepEqual(manifests,[m1,m1]);assert.equal(s.db.inspect().exploreEpochManifest.length,1);
      s.setCatalogue(fixtures.futureCatalogue);assert.deepEqual(await s.service.publish(scenario.epoch),m1);
      break;
    }
    case 'offline-first-claim-after-catalogue-and-config-change': {
      await bind(s);await bind(s,m2,fixtures.futureCatalogue);s.setCatalogue(fixtures.futureCatalogue);
      const result=await s.service.pickup(1,scenario.command);
      assert.deepEqual(result.receipt,scenario.expectedReceipt);
      assert.notEqual(result.receipt.itemKey,scenario.incorrectLatestRecomputedItemKey);break;
    }
    case 'pending-restart': {
      await bind(s);const wire=JSON.parse(JSON.stringify(scenario.diskBeforeRestart.command));
      assert.equal(s.db.inspect().exploreLocationReceipt.length,0);
      assert.equal((await s.service.pickup(1,wire)).result,'saved');
      assert.equal((await s.service.pickup(1,wire)).result,'already_saved');break;
    }
    case 'account-change': {
      await bind(s);await s.service.pickup(1,command);
      assert.equal((await s.service.collection(2)).summary.savedFindCount,0);
      const b=await s.service.pickup(2,command);assert.equal(b.result,'saved');
      assert.notEqual(b.receipt.receiptId,receipt.receiptId);break;
    }
    case 'stale-read-after-save': {
      await bind(s);const old=await s.service.collection(1);await s.service.pickup(1,command);
      const fresh=await s.service.collection(1);
      assert.equal(old.summary.revision,scenario.snapshotRevision);assert.equal(fresh.summary.revision,scenario.localRevision);
      assert.deepEqual(fresh.history.map(r=>r.receiptId),scenario.expectedReceiptIds);break;
    }
    case 'permission-denial': {
      const r=await http(s.service,{method:'GET',path:'/api/auth/explore/collection',body:null});
      assert.equal(r.status,200);assert.deepEqual(r.body.data.history,[]);break;
    }
    case 'rollover-during-encounter': {
      await bind(s);s.setTime('2026-10-19T05:31:00Z');assert.equal((await s.service.pickup(1,command)).result,'saved');break;
    }
    default:
      assert.ok(scenario.name.startsWith('B1-'),'fixture needs an explicit scope decision');
      t.skip('E3-B1 daily sets and breakthrough issuance are outside E2/E3-A');
  }
});

test('concurrent same-command claims, timeout retry, different-command conflict and late replay',async()=>{
  const s=setup();await bind(s);
  const results=await Promise.all(Array.from({length:6},()=>s.service.pickup(1,command)));
  assert.equal(results.filter(r=>r.result==='saved').length,1);
  assert.ok(results.every(r=>r.receipt.receiptId===receipt.receiptId));
  assert.equal((await s.service.collection(1)).summary.revision,1);
  s.setTime('2026-12-01T00:00:00Z');
  const retry=await s.service.pickup(1,command);assert.equal(retry.result,'already_saved');assert.deepEqual(retry.delta.addedReceiptIds,[]);
  const duplicate=await s.service.pickup(1,{...command,claimId:'new-claim'});assert.equal(duplicate.result,'already_saved');
  await assert.rejects(s.service.pickup(1,{...command,completedAt:'2026-10-19T05:30:31Z'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('receipt, progress and command outcome roll back together on storage failure',async()=>{
  const s=setup();await bind(s);s.db.failNext('exploreClaim');
  await assert.rejects(s.service.pickup(1,command));
  const tables=s.db.inspect();assert.equal(tables.exploreLocationReceipt.length,0);assert.equal(tables.exploreProgress.length,0);
  assert.equal((await s.service.pickup(1,command)).result,'saved');
});
test('rejections are terminal, proof-free, unawarded and account-scoped',async()=>{
  const s=setup();await bind(s);
  const invalid={...command,position:{...command.position,latitude:command.position.latitude+1}};
  const rejected=await s.service.pickup(1,invalid);
  assert.equal(rejected.reason.code,'OUTSIDE_GEOFENCE');assert.equal(rejected.summary.revision,0);assert.deepEqual(rejected.delta.addedReceiptIds,[]);
  s.setTime('2026-12-01T00:00:00Z');assert.deepEqual(await s.service.pickup(1,invalid),rejected);
  await assert.rejects(s.service.pickup(1,command),e=>e.code==='IDEMPOTENCY_CONFLICT');
  const stored=s.db.inspect();assert.equal(stored.exploreLocationReceipt.length,0);
  const text=JSON.stringify(stored);for(const key of ['latitude','longitude','accuracyMeters','speedMetersPerSecond','fixAt','capturedAt','position'])assert.ok(!text.includes(key));
});
test('flag off disables issuance while published queue and history stay readable',async()=>{
  const s=setup();await bind(s);
  await assert.rejects(s.service.nearby(1,{},{}),e=>e.code==='FEATURE_DISABLED');
  assert.equal((await s.service.pickup(1,command)).result,'saved');
  assert.equal((await s.service.collection(1)).summary.savedFindCount,1);
  assert.equal((await s.service.catalogue({version:1,hash:catalogueV1.contentHash})).contentHash,catalogueV1.contentHash);
});
test('cursor merges both classes, pins totals and order across later inserts, and rejects cross-account/tampering',async()=>{
  const s=setup();await seed(s,[receipt,fixtures.rewardExamples[0]]);
  const first=await s.service.collection(1,{limit:1});assert.equal(first.history[0].source,'reward');assert.equal(first.summary.savedFindCount,2);
  const later={...receipt,receiptId:'loc-later',occurrenceId:'another',acknowledgedAt:'2026-10-21T00:00:00Z'};
  await s.db.exploreLocationReceipt.create({data:{userId:1,revision:3,receiptId:later.receiptId,payload:later}});
  await s.db.exploreProgress.update({where:{userId:1},data:{revision:3}});
  const second=await s.service.collection(1,{limit:1,cursor:first.nextCursor});
  assert.equal(second.summary.savedFindCount,2);assert.equal(second.summary.revision,2);assert.deepEqual(second.history,[receipt]);assert.equal(second.nextCursor,null);assert.equal(second.snapshotAt,first.snapshotAt);
  await assert.rejects(s.service.collection(2,{cursor:first.nextCursor}),e=>e.code==='CURSOR_INVALID');
  await assert.rejects(s.service.collection(1,{cursor:first.nextCursor+'x'}),e=>e.code==='CURSOR_INVALID');
});
test('validation rejects spoofed award/account fields, malformed identities, timestamps and position values',async()=>{
  const s=setup();await bind(s);
  const bad=[{...command,itemKey:'dal_khichdi'},{...command,userId:2},{...command,occurrenceId:'ff1_20260230_1_0_0_0'},{...command,occurrenceId:'ff1_20261019_01_0_0_0'},{...command,occurrenceId:'ff1_20261019_1_36000_0_0'},{...command,occurrenceId:'breakthrough:1'},{...command,startedAt:'2026-10-19T05:29:40+00:00'}, {...command,position:{...command.position,capturedAt:'2026-10-19T05:29:41Z'}},{...command,position:{...command.position,latitude:91}}];
  for(const value of bad)await assert.rejects(s.service.pickup(1,value),e=>e.code==='INVALID_REQUEST');
  for(const value of ['ff1_20261019_1_0_72000_0','ff1_20261019_5_0_0_0','ff1_20261019_1_0_0_4'])assert.equal(parseOccurrence(value),null);
});
test('validation order favors start, freshness, accuracy, distance, speed, duration, upload',async()=>{
  const s=setup();await bind(s);
  const changes=[
    [{startedAt:'2026-10-19T05:30:00Z',completedAt:'2026-10-19T05:30:01Z'}, {accuracyMeters:31}, 'START_OUTSIDE_WINDOW'],
    [{},{fixAt:'2026-10-19T05:29:09Z',accuracyMeters:31},'FIX_STALE'],
    [{},{accuracyMeters:31,latitude:0},'FIX_INACCURATE'],
    [{},{latitude:0,speedMetersPerSecond:5},'OUTSIDE_GEOFENCE'],
    [{completedAt:'2026-10-19T05:30:41Z'},{speedMetersPerSecond:5},'MOVING_TOO_FAST'],
    [{},{speedMetersPerSecond:-1},'SPEED_UNCONFIRMED'],
    [{},{speedConfirmed:false},'SPEED_UNCONFIRMED'],
    [{completedAt:'2026-10-19T05:29:39Z'},{},'INVALID_TIMESTAMPS'],
  ];
  let i=0;for(const [times,p,expected] of changes) {
    const c={...command,...times,claimId:`order-${i++}`,position:{...command.position,...p,capturedAt:times.startedAt??command.startedAt}};
    assert.equal((await s.service.pickup(1,c)).reason.code,expected);
  }
});
test('service customer auth errors use typed envelope and never accept a body account',async()=>{
  const s=setup();
  for(const [headers,status,code] of [[{'x-user-id':''},401,'AUTH_REQUIRED'],[{'x-user-id':'1e1'},401,'AUTH_REQUIRED'],[{'x-user-role':'partner'},403,'FORBIDDEN']]) {
    const r=await http(s.service,{method:'GET',path:'/api/auth/explore/collection',body:null},headers);
    assert.equal(r.status,status);assert.equal(r.body.error.code,code);
  }
});
test('unexpected/storage exceptions are redacted and infrastructure failures are retryable',async()=>{
  for(const [error,code,status] of [[new Error('private proof in diagnostic'),'INTERNAL_ERROR',500],[Object.assign(new Error('private SQL'),{code:'P1001'}),'WORLD_UNAVAILABLE',503]]) {
    const r=await http({catalogue:()=>{throw error;}},{method:'GET',path:'/api/auth/explore/catalogue',body:null});
    assert.equal(r.status,status);assert.equal(r.body.error.code,code);assert.equal(r.body.error.retryable,true);assert.ok(!JSON.stringify(r.body).includes('private'));
  }
});


test('nearby/catalogue/collection requests enforce bounds, scalar queries and location headers',async()=>{
  const s=setup();await s.db.appVersionSetting.create({data:{id:1,config:{features:{exploreFoodFinds:{enabled:true}}}}});
  const headers={'x-user-lat':'12.970968','x-user-lng':'77.59191'};
  for(const query of [{radiusMeters:0},{radiusMeters:301},{limit:201},{limit:['1','2']},{latitude:12},{radiusMeters:'1.5'}])await assert.rejects(s.service.nearby(1,query,headers),e=>e.code==='INVALID_REQUEST');
  for(const query of [{limit:0},{limit:101},{cursor:[]},{accountId:42}])await assert.rejects(s.service.collection(1,query),e=>['INVALID_REQUEST','CURSOR_INVALID'].includes(e.code));
  for(const query of [{version:1},{version:'01',hash:'x'},{version:1,hash:['x']},{version:1,hash:'x',longitude:0}])await assert.rejects(s.service.catalogue(query),e=>e.code==='INVALID_REQUEST');
  await assert.rejects(s.service.catalogue({version:999,hash:'x'}),e=>e.code==='CATALOGUE_NOT_FOUND');
  await assert.rejects(s.service.catalogue({version:1,hash:'x'}),e=>e.code==='CATALOGUE_HASH_MISMATCH');
  for(const h of [{},{'x-user-lat':'0'},{...headers,'x-user-lat':'91'},{...headers,'x-user-lng':'NaN'}])await assert.rejects(s.service.nearby(1,{},h),e=>['LOCATION_REQUIRED','INVALID_REQUEST'].includes(e.code));
});
test('all non-distance timing probes run through full pickup validation',async()=>{
  for(const c of fixtures.timingCases.filter(c=>!c.name.startsWith('radius-'))) {
    const s=setup(c.uploadedAt);await bind(s);
    const body={...command,startedAt:c.startedAt,completedAt:c.completedAt,position:{...command.position,fixAt:c.fixAt,capturedAt:c.startedAt,accuracyMeters:c.accuracy,speedMetersPerSecond:c.speed,speedConfirmed:c.speed!==null}};
    const r=await s.service.pickup(1,body);
    assert.equal(r.result,c.expectedResult,c.name);assert.equal(r.reason?.code??null,c.reason,c.name);
  }
});
test('a rejected unknown location ID stays terminal, and reward identities never become pickups',async()=>{
  const s=setup();await bind(s);
  const r=await s.service.pickup(1,{...command,occurrenceId:'unknown-location'});
  assert.equal(r.result,'rejected');assert.equal(r.reason.code,'UNKNOWN_OCCURRENCE');assert.equal(r.summary.savedFindCount,0);
});
test('published catalogue bindings are retained and corrupt/changed bindings fail without latest substitution',async()=>{
  const s=setup();await bind(s);await bind(s,m2,fixtures.futureCatalogue);
  s.setCatalogue(fixtures.futureCatalogue);
  assert.deepEqual(await s.service.catalogue({version:1,hash:catalogueV1.contentHash}),catalogueV1);
  assert.deepEqual(await s.service.catalogue({version:2,hash:fixtures.futureCatalogue.contentHash}),fixtures.futureCatalogue);
  await s.db.exploreEpochManifest.update({where:{epochManifestId:m1.epochManifestId},data:{payload:{...m1,catalogueHash:'bad-binding'}}});
  await assert.rejects(s.service.pickup(1,command),e=>e.code==='WORLD_UNAVAILABLE');
  assert.equal(s.db.inspect().exploreLocationReceipt.length,0);
});
test('find counts grow for duplicates while variety/milestones remain identity-based across both classes',async()=>{
  const {summary}=await import('../exploration/contracts.js');
  let records=[receipt,{...receipt,receiptId:'loc-duplicate'}];
  assert.equal(summary(records,2).savedFindCount,2);assert.equal(summary(records,2).varietyCount,1);
  records.push(fixtures.rewardExamples[0],{...fixtures.rewardExamples[0],itemKey:'idli_sambar',receiptId:'third-key'});
  const totals=summary(records,4);assert.equal(totals.varietyCount,3);assert.equal(totals.locationFindCount,2);assert.equal(totals.rewardFindCount,2);
  assert.ok(totals.milestones.includes('three_varieties'));
  const all=catalogueV1.items.map((item,i)=>({...receipt,itemKey:item.itemKey,receiptId:'loc-'+i}));
  assert.equal(summary(all,12).coreVarietyCount,12);assert.ok(summary(all,12).milestones.includes('twelve_core_varieties'));
});


test('stored claim fingerprints require the server secret and retain canonical-command idempotency',async()=>{
  const secret='test-only-fingerprint-secret';
  const s=setup(receipt.acknowledgedAt,secret);await bind(s);
  await s.service.pickup(1,command);
  const stored=s.db.inspect().exploreClaim[0].fingerprint;
  const digest=stored.slice('hmac-sha256:'.length);
  assert.match(stored,/^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(digest,createHmac('sha256',secret).update(canonical(command),'utf8').digest('hex'));
  assert.notEqual(digest,createHash('sha256').update(canonical(command),'utf8').digest('hex'));
  assert.notEqual(digest,createHash('sha256').update(JSON.stringify(command),'utf8').digest('hex'));
  const other=setup(receipt.acknowledgedAt,'different-test-secret');await bind(other);
  await other.service.pickup(1,command);
  assert.notEqual(other.db.inspect().exploreClaim[0].fingerprint,stored);
  const reordered={...Object.fromEntries(Object.entries(command).reverse()),position:Object.fromEntries(Object.entries(command.position).reverse())};
  assert.equal((await s.service.pickup(1,reordered)).result,'already_saved');
  await assert.rejects(s.service.pickup(1,{...command,position:{...command.position,accuracyMeters:11}}),e=>e.code==='IDEMPOTENCY_CONFLICT');
});

test('claim fingerprints default to JWT_SECRET and fail closed without it before persistence',async()=>{
  const previous=process.env.JWT_SECRET;
  try {
    const db=memoryDb();
    for(const absent of [undefined,'','   ']) {
      if(absent===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=absent;
      const service=createExploreService({db});
      await assert.rejects(service.pickup(1,command),e=>e.code==='WORLD_UNAVAILABLE');
      assert.equal(db.inspect().exploreClaim.length,0);
      assert.equal(db.inspect().exploreProgress.length,0);
      assert.equal(db.inspect().exploreLocationReceipt.length,0);
    }
    process.env.JWT_SECRET='test-env-fingerprint-secret';
    const s={db,service:createExploreService({db,now:()=>receipt.acknowledgedAt})};
    await bind(s);await s.service.pickup(1,command);
    assert.equal(db.inspect().exploreClaim[0].fingerprint,'hmac-sha256:'+createHmac('sha256',process.env.JWT_SECRET).update(canonical(command),'utf8').digest('hex'));
  } finally {
    if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;
  }
});
