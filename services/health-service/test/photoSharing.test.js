import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {SHARING_CONSENT_VERSION as version,getSharingPreference,setSharingPreference,shareConfirmedPhoto,tryShareConfirmedPhoto,withdrawSharing} from '../services/ledger/photoSharingService.js';
const original=process.env.FOOD_PHOTO_CONTRIBUTIONS;
afterEach(()=>{if(original==null)delete process.env.FOOD_PHOTO_CONTRIBUTIONS;else process.env.FOOD_PHOTO_CONTRIBUTIONS=original;});
function fixture() {
 const choices=new Map(),copies=new Map();let tail=Promise.resolve();
 const db={
  $executeRaw:async()=>1,
  $transaction:async work=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;try{return await work(db);}finally{release();}},
  foodPhotoSharingPreference:{findUnique:async({where})=>choices.get(where.userId),upsert:async({where,create,update})=>{const row=choices.has(where.userId)?{...choices.get(where.userId),...update}:create;choices.set(where.userId,row);return row;}},
  foodPhotoContribution:{findUnique:async({where})=>copies.get(JSON.stringify(where.userId_sourcePhotoPath)),findMany:async()=>[],},
  foodLog:{count:async()=>1},
 };
 const save=async(_tx,userId,{photoPath})=>copies.set(JSON.stringify({userId,sourcePhotoPath:photoPath}),{id:1});
 return {db,choices,copies,save};
}
test('no permission by default; old per-photo version cannot grant future sharing',async()=>{
 const {db,choices}=fixture();process.env.FOOD_PHOTO_CONTRIBUTIONS='true';
 assert.equal((await getSharingPreference(db,1)).decided,false);
 choices.set(1,{enabled:true,consentVersion:'food-research-2026-10-29-v1'});
 assert.equal((await getSharingPreference(db,1)).enabled,false);
 await assert.rejects(setSharingPreference(db,1,{enabled:true,consentVersion:'old'}),{status:400});
});
test('both allow and decline persist on the account without sharing another account data',async()=>{
 const {db}=fixture();process.env.FOOD_PHOTO_CONTRIBUTIONS='true';
 await setSharingPreference(db,1,{enabled:true,consentVersion:version});
 await setSharingPreference(db,2,{enabled:false,consentVersion:version});
 assert.equal((await getSharingPreference(db,1)).enabled,true);
 assert.equal((await getSharingPreference(db,2)).decided,true);
 assert.equal((await getSharingPreference(db,2)).enabled,false);
 assert.equal((await getSharingPreference(db,3)).decided,false);
});
test('collection off never copies; enabling a choice fails while unavailable',async()=>{
 const {db,save,copies}=fixture();delete process.env.FOOD_PHOTO_CONTRIBUTIONS;
 await assert.rejects(setSharingPreference(db,1,{enabled:true,consentVersion:version}),{status:503});
 assert.equal((await shareConfirmedPhoto(db,1,'food/1/a',{save})).outcome,'disabled');assert.equal(copies.size,0);
});
test('automatic copies require current account consent and a confirmed log',async()=>{
 const {db,save,copies}=fixture();process.env.FOOD_PHOTO_CONTRIBUTIONS='true';
 assert.equal((await shareConfirmedPhoto(db,1,'food/1/a',{save})).outcome,'not_opted_in');
 await setSharingPreference(db,1,{enabled:true,consentVersion:version});
 db.foodLog.count=async()=>0;
 assert.equal((await shareConfirmedPhoto(db,1,'food/1/a',{save})).outcome,'not_confirmed');assert.equal(copies.size,0);
});
test('concurrent confirmations create only one copy and sharing failures do not fail logging',async()=>{
 const {db,save,copies}=fixture();process.env.FOOD_PHOTO_CONTRIBUTIONS='true';
 await setSharingPreference(db,1,{enabled:true,consentVersion:version});
 const results=await Promise.all([shareConfirmedPhoto(db,1,'food/1/a',{save}),shareConfirmedPhoto(db,1,'food/1/a',{save})]);
 assert.deepEqual(results.map(r=>r.outcome),['shared','already_shared']);assert.equal(copies.size,1);
 assert.equal((await tryShareConfirmedPhoto(db,1,'food/1/b',{save:async()=>{throw Error('storage');}})).outcome,'failed');
});
test('withdrawal remembers off even without an earlier decision and stops future collection',async()=>{
 const {db,save}=fixture();process.env.FOOD_PHOTO_CONTRIBUTIONS='true';
 await withdrawSharing(db,1);
 assert.equal((await getSharingPreference(db,1)).decided,true);
 assert.equal((await shareConfirmedPhoto(db,1,'food/1/a',{save})).outcome,'not_opted_in');
});
