import { createHmac, randomUUID } from 'node:crypto';
import { clock, scanRadius, gridOccurrence, haversineMeters } from './generator.js';
import { catalogueV1, canonical, hash, fail, queryKeys, integer, id, validateCommand, parseOccurrence, resolveGrid, timingReason, windowBounds, noDelta, summary, cursorCodec } from './contracts.js';

export function createExploreService({db, now=()=>new Date().toISOString(), receiptId=()=>`loc-${randomUUID()}`, cursorSecret=process.env.JWT_SECRET, fingerprintSecret=process.env.JWT_SECRET, currentCatalogue=()=>catalogueV1}) {
  const cursors=cursorCodec(cursorSecret);
  async function catalogueFrom(tx, version) {
    const row=await tx.exploreCatalogue.findUnique({where:{version}});
    const cat=row?.payload ?? (version===1 ? catalogueV1 : null);
    if (cat) {
      const {contentHash,...payload}=cat;
      if (hash(payload)!==contentHash || (row && row.hash!==contentHash)) fail('WORLD_UNAVAILABLE');
    }
    return cat;
  }
  async function catalogue(query={}) {
    queryKeys(query,['version','hash']);
    const version=integer(query.version,1,2147483647);
    if (!id(query.hash)) fail('INVALID_REQUEST');
    const cat=await catalogueFrom(db,version);
    if (!cat) fail('CATALOGUE_NOT_FOUND');
    if (cat.contentHash!==query.hash) fail('CATALOGUE_HASH_MISMATCH');
    return cat;
  }
  async function enabled() {
    const row=await db.appVersionSetting.findUnique({where:{id:1}});
    return row?.config?.features?.exploreFoodFinds?.enabled===true;
  }
  async function publish(epoch) {
    // The candidate configuration comes from the server, never from claim input.
    // Native INSERT ON CONFLICT DO NOTHING returns the committed winner below.
    return db.$transaction(async tx=>{
      const key={epoch,worldGeneration:1};
      const existing=await tx.exploreEpochManifest.findUnique({where:{epoch_worldGeneration:key}});
      if (existing) return existing.payload;
      const cat=currentCatalogue();
      const {contentHash,...payload}=cat;
      if (hash(payload)!==contentHash || hash(cat.dropConfiguration)!==cat.dropConfigurationHash) fail('WORLD_UNAVAILABLE');
      await tx.exploreCatalogue.createMany({data:[{version:cat.catalogueVersion,hash:contentHash,payload:cat}],skipDuplicates:true});
      const stored=await catalogueFrom(tx,cat.catalogueVersion);
      if (!stored || stored.contentHash!==contentHash) fail('WORLD_UNAVAILABLE');
      const manifest={epochManifestId:`em1_${epoch}_1`,epoch,worldGeneration:1,timezone:'Asia/Kolkata',windows:cat.windows,generatorVersion:1,catalogueVersion:cat.catalogueVersion,catalogueHash:contentHash,goldenOneIn:cat.goldenOneIn,dropRegionVersion:cat.dropConfiguration.version,dropRegionHash:cat.dropConfigurationHash};
      await tx.exploreEpochManifest.createMany({data:[{epochManifestId:manifest.epochManifestId,...key,payload:manifest}],skipDuplicates:true});
      return (await tx.exploreEpochManifest.findUnique({where:{epoch_worldGeneration:key}})).payload;
    });
  }
  async function nearby(userId,query={},headers={}) {
    if (!(await enabled())) fail('FEATURE_DISABLED');
    queryKeys(query,['radiusMeters','limit']);
    const radiusMeters=integer(query.radiusMeters,1,300,300),limit=integer(query.limit,1,200,200);
    const coordinates=['x-user-lat','x-user-lng'].map(k=>headers[k]);
    if (coordinates.some(v=>v===undefined||v==='')) fail('LOCATION_REQUIRED');
    if (coordinates.some(v=>typeof v!=='string'||v.trim()!==v||!Number.isFinite(Number(v)))) fail('INVALID_REQUEST');
    const [latitude,longitude]=coordinates.map(Number);
    if (Math.abs(latitude)>90||Math.abs(longitude)>180) fail('INVALID_REQUEST');
    const serverTime=now(),{epoch,window}=clock(serverTime);
    const manifest=await publish(epoch),cat=await catalogueFrom(db,manifest.catalogueVersion);
    if (!cat) fail('WORLD_UNAVAILABLE');
    resolveGrid({epoch,window,row:0,col:0,slot:0},manifest,cat);
    const found=scanRadius({epoch,window,latitude,longitude,radiusMeters},cat);
    return {manifest,worldState:'available',serverTime,currentWindow:window,occurrences:found.slice(0,limit).map(spawn=>gridOccurrence(spawn,epoch,window)),activeDrops:[],suggestions:[],dailySet:null,truncated:found.length>limit};
  }
  async function readReceipts(tx,userId,revision) {
    const where={userId,...(revision===undefined?{}:{revision:{lte:revision}})};
    const [locations,rewards]=await Promise.all([
      tx.exploreLocationReceipt.findMany({where}),tx.exploreRewardReceipt.findMany({where}),
    ]);
    return [...locations,...rewards].map(row=>row.payload);
  }
  async function collection(userId,query={}) {
    queryKeys(query,['limit','cursor']);
    const limit=integer(query.limit,1,100,50);
    const bound=query.cursor===undefined?null:cursors.decode(query.cursor,userId);
    return db.$transaction(async tx=>{
      const progress=await tx.exploreProgress.findUnique({where:{userId}});
      const revision=bound?.revision??progress?.revision??0;
      if (revision>(progress?.revision??0)) fail('CURSOR_INVALID');
      const snapshotAt=bound?.snapshotAt??now(),offset=bound?.offset??0;
      const receipts=await readReceipts(tx,userId,revision);
      receipts.sort((a,b)=>Date.parse(b.acknowledgedAt)-Date.parse(a.acknowledgedAt)||(a.receiptId<b.receiptId?1:a.receiptId>b.receiptId?-1:0));
      const next=offset+limit;
      return {history:receipts.slice(offset,next),nextCursor:next<receipts.length?cursors.encode({userId,revision,snapshotAt,offset:next}):null,snapshotAt,summary:summary(receipts,revision)};
    },{isolationLevel:'RepeatableRead'});
  }
  async function pickup(userId,body) {
    const command=validateCommand(body);
    // A keyed digest prevents recreating position-bearing commands from stored fingerprints.
    // Refuse claims before any persistence if the server secret is unavailable.
    if (typeof fingerprintSecret !== 'string' || !fingerprintSecret.trim()) fail('WORLD_UNAVAILABLE');
    const fingerprint='hmac-sha256:'+createHmac('sha256',fingerprintSecret).update(canonical(command),'utf8').digest('hex');
    const receivedAt=now();
    return db.$transaction(async tx=>{
      // Lock the parent account before progress creation, serializing all award writers
      // (including future B1 rewards) and coordinating with account deletion.
      await tx.$queryRaw`SELECT "id" FROM "auth"."User" WHERE "id" = ${userId} FOR UPDATE`;
      await tx.exploreProgress.createMany({data:[{userId,revision:0}],skipDuplicates:true});
      const progress=await tx.exploreProgress.findUnique({where:{userId}});
      const receipts=await readReceipts(tx,userId);
      const before=summary(receipts,progress.revision);
      const previous=await tx.exploreClaim.findUnique({where:{userId_claimId:{userId,claimId:command.claimId}}});
      if (previous && previous.fingerprint!==fingerprint) fail('IDEMPOTENCY_CONFLICT');
      const result=(receipt,reason,awarded=false,after=before,delta=noDelta())=>({result:reason?'rejected':awarded?'saved':'already_saved',claimId:command.claimId,receipt:receipt??null,reason:reason?{code:reason,messageKey:'explore.error.'+reason.toLowerCase(),retryable:false}:null,summary:after,delta});
      if (previous) {
        const receipt=previous.receiptId?receipts.find(r=>r.receiptId===previous.receiptId):null;
        if (previous.receiptId&&!receipt) fail('WORLD_UNAVAILABLE');
        return result(receipt,previous.reason);
      }
      const remember=async(receipt,reason)=>tx.exploreClaim.create({data:{userId,claimId:command.claimId,fingerprint,receiptId:receipt?.receiptId??null,reason}});
      const parsed=parseOccurrence(command.occurrenceId);
      // Only grid occurrences are issued in A. Anchors become resolvable in B1/B2.
      if (!parsed) { await remember(null,'UNKNOWN_OCCURRENCE'); return result(null,'UNKNOWN_OCCURRENCE'); }
      const row=await tx.exploreEpochManifest.findUnique({where:{epochManifestId:command.epochManifestId}});
      if (!row) fail('MANIFEST_UNPUBLISHED');
      const manifest=row.payload;
      if (manifest.epoch!==parsed.epoch||manifest.worldGeneration!==parsed.worldGeneration) fail('MANIFEST_MISMATCH');
      // Identity is checked before timing/evidence. Saved finds survive grace and rollback.
      const saved=receipts.find(r=>r.source==='location'&&r.occurrenceId===command.occurrenceId);
      if (saved) { await remember(saved,null); return result(saved,null); }
      const cat=await catalogueFrom(tx,manifest.catalogueVersion);
      if (!cat) fail('WORLD_UNAVAILABLE');
      const spawn=resolveGrid(parsed,manifest,cat);
      const p=command.position;
      const reason=timingReason({startedAt:command.startedAt,completedAt:command.completedAt,fixAt:p.fixAt,uploadedAt:receivedAt,accuracy:p.accuracyMeters,distance:haversineMeters(p.latitude,p.longitude,spawn.latitude,spawn.longitude),speed:p.speedMetersPerSecond,speedConfirmed:p.speedConfirmed},windowBounds(parsed.epoch,parsed.window,manifest.windows));
      if (reason) { await remember(null,reason); return result(null,reason); }
      const receipt={receiptId:receiptId(),source:'location',kind:'grid',occurrenceId:command.occurrenceId,epochManifestId:manifest.epochManifestId,anchorId:null,generatorVersion:manifest.generatorVersion,catalogueVersion:manifest.catalogueVersion,itemKey:spawn.pick.itemKey,golden:spawn.golden,startedAt:command.startedAt,completedAt:command.completedAt,acknowledgedAt:receivedAt};
      const revision=progress.revision+1,after=summary([...receipts,receipt],revision);
      await tx.exploreLocationReceipt.create({data:{receiptId:receipt.receiptId,userId,occurrenceId:receipt.occurrenceId,epochManifestId:receipt.epochManifestId,revision,acknowledgedAt:new Date(receivedAt),payload:receipt}});
      await tx.exploreProgress.update({where:{userId},data:{revision}});
      await remember(receipt,null);
      const delta={addedReceiptIds:[receipt.receiptId],newVarietyKeys:receipts.some(r=>r.itemKey===receipt.itemKey)?[]:[receipt.itemKey],newMilestones:after.milestones.filter(m=>!before.milestones.includes(m)),dailySetEpoch:null};
      return result(receipt,null,true,after,delta);
    });
  }
  return {catalogue,collection,nearby,pickup,publish};
}
