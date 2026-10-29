import {test} from 'node:test';
import assert from 'node:assert/strict';
import {geminiUsage,priceUsage,measuredCall} from '../services/ledger/photoMeasurement.js';
import {duplicateKey,generationControls} from '../services/ledger/photoExperiments.js';
import {wilson,report,validateDataset,passes} from '../services/ledger/photoEvaluation.js';
import {initialLabel} from '../services/ledger/photoContribution.js';
import {mealSlotFor,shortlistRows,resetPopularityCache} from '../services/ledger/foodPhotoService.js';
test('missing usage differs from zero; thinking billed at output rate',()=>{
 assert.equal(geminiUsage({},'m').thinkingTokens,null);
 const u={tokensIn:100,tokensOut:20,thinkingTokens:30,cachedTokens:0};
 assert.equal(priceUsage(u,{input:1,output:5,cachedInput:0}),.00035);
 assert.equal(priceUsage({...u,thinkingTokens:null},{input:1,output:5}),null);
});
test('failed paid parse retains usage',async()=>{
 let row;const db={foodPhotoUsage:{create:async x=>{row=x.data;}}};
 await assert.rejects(measuredCall(db,1,'recognition',async()=>{throw Object.assign(new Error('parse'),{usage:{tokensIn:5,thinkingTokens:7}});}));
 assert.equal(row.tokensIn,5);assert.equal(row.thinkingTokens,7);assert.equal(row.outcome,'error');
});
test('exact cache partitions bytes, person and configuration',()=>{
 const key=duplicateKey(1,Buffer.from('a'),{v:1});
 assert.notEqual(key,duplicateKey(2,Buffer.from('a'),{v:1}));
 assert.notEqual(key,duplicateKey(1,Buffer.from('b'),{v:1}));
 assert.notEqual(key,duplicateKey(1,Buffer.from('a'),{v:2}));
 // An unsupported control is skipped, not thrown: the rotation mixes models.
 assert.deepEqual(generationControls('gemini-2.0-flash',{thinking:'low',lowResolution:true}),{});
 assert.deepEqual(generationControls('gemini-3.6-flash',{thinking:'low',lowResolution:true}),{mediaResolution:'MEDIA_RESOLUTION_LOW',thinkingConfig:{thinkingLevel:'low'}});
 assert.deepEqual(generationControls('gemini-2.5-flash-lite',{thinking:'0'}),{thinkingConfig:{thinkingBudget:0}});
});
test('reports uncertainty and incomplete costs without invented metrics',()=>{
 assert.equal(report([],[]).n,0);assert.equal(wilson(0,0),null);
 const r=report([{id:1,foodIds:[2],dietaryType:'veg',category:'single'}],[{id:1,accepted:true,foodIds:[2],dietaryType:'non_veg',latencyMs:100}]);
 assert.equal(r.totalCostUsd,null);assert.equal(r.dietaryErrors,1);assert.equal(r.coverage,1);assert.ok(r.precision95[0]<1);
});
test('person-disjoint splits and reviewed labels enforced',()=>{
 const row={id:1,person:'p',consentVersion:'v1',expiresAt:'2099-01-01',split:'reference',strength:'weak'};
 validateDataset([row]);
 assert.throws(()=>validateDataset([{...row,strength:undefined}]),/strength/);
 assert.throws(()=>validateDataset([row,{...row,id:2,split:'holdout'}]),/leakage/);
 // A weak label never reaches calibration or the final test.
 const reviewed={id:3,person:'q',consentVersion:'v1',expiresAt:'2099-01-01',split:'holdout',reviewer:'r',category:'single',foodIds:[1],dietaryType:'veg'};
 assert.throws(()=>validateDataset([{...reviewed,strength:'weak'}]),/Human-reviewed/);
 validateDataset([{...reviewed,strength:'strong'}]);
});

test('cache reuses identical proposals, expires entries and never stores failures',async()=>{
 const {cachedRecognition}=await import('../services/ledger/photoExperiments.js');
 const old=process.env.FOOD_PHOTO_EXACT_CACHE;process.env.FOOD_PHOTO_EXACT_CACHE='true';
 let entry=null,calls=0;
 // No transaction: a held transaction around the paid call exhausted the pool.
 const db={$transaction:async()=>{throw new Error('must not hold a transaction');},foodPhotoRecognitionCache:{findUnique:async()=>entry,upsert:async({create})=>{entry=create;}}};
 const args={userId:1,buffer:Buffer.from('a'),configuration:{v:1},now:new Date('2026-01-01')};
 const call=async()=>{calls++;return {isFood:true,items:[{name:'rice'}]};};
 try {
 await cachedRecognition(db,args,call);
 const again=await cachedRecognition(db,args,call);
 assert.equal(calls,1);assert.equal(again.cacheHit,true);
 await cachedRecognition(db,{...args,now:new Date('2027-01-01')},call);assert.equal(calls,2);
 entry=null;await assert.rejects(cachedRecognition(db,args,async()=>{throw new Error('failed');}));assert.equal(entry,null);
 } finally {if(old==null)delete process.env.FOOD_PHOTO_EXACT_CACHE;else process.env.FOOD_PHOTO_EXACT_CACHE=old;}
});
test('compact Gemini schema and enrichment are separately selectable',async()=>{
 const {recognizeFood}=await import('../services/ledger/providers/geminiVisionProvider.js');
 const oldFetch=globalThis.fetch; const old=process.env.FOOD_PHOTO_NUTRITION_MODE;
 let sent;
 globalThis.fetch=async(_url,req)=>{sent=JSON.parse(req.body);return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"isFood":true,"items":[]}' }]} }],usageMetadata:{promptTokenCount:10,candidatesTokenCount:4,thoughtsTokenCount:2}})};};
 try {
 process.env.FOOD_PHOTO_NUTRITION_MODE='separate';
 await recognizeFood({imageBase64:'abc',mimeType:'image/jpeg'},{apiKey:'test',model:'gemini-2.5-flash'});
 assert.deepEqual(sent.generationConfig.responseSchema.properties.items.items.required,['name','dietaryType']);
 await recognizeFood({enrichmentName:'Paneer tikka'},{apiKey:'test',model:'gemini-2.5-flash'});
 assert.equal(sent.contents[0].parts.some(p=>p.inlineData),false);
 assert.ok(sent.generationConfig.responseSchema.properties.items.items.required.includes('nutrition'));
 } finally {globalThis.fetch=oldFetch;if(old==null)delete process.env.FOOD_PHOTO_NUTRITION_MODE;else process.env.FOOD_PHOTO_NUTRITION_MODE=old;}
});

test('a confirmed photo starts weak, a corrected one stronger, nothing unlabelled is invented',()=>{
 assert.deepEqual(initialLabel([{foodItemId:4,photoCorrections:0}]),{strength:'weak',source:'user_confirmed',foodIds:[4]});
 assert.equal(initialLabel([{foodItemId:4,photoCorrections:1},{foodItemId:5,photoCorrections:0}]).strength,'stronger');
 assert.equal(initialLabel([]),null);
});
test('withdrawal never blocks on storage; failed blobs are left expired for the sweep',async(t)=>{
 // Storage is mocked to fail every delete; no test may reach a real bucket.
 t.mock.module('../services/ledger/foodPhotoStorage.js',{namedExports:{
  deletePhotos:async(paths)=>({deleted:0,failed:paths}),readPhoto:async()=>Buffer.alloc(0),saveContribution:async()=>'x',
 }});
 const {removeContributions}=await import('../services/ledger/photoContribution.js?withdrawal');
 const calls=[];
 const db={foodPhotoContribution:{
  findMany:async()=>[{id:1,path:'food/9/contributions/a.jpg'}],
  deleteMany:async(a)=>{calls.push(['deleteMany',a]);return {count:0};},
  updateMany:async(a)=>{calls.push(['updateMany',a]);return {count:1};},
 }};
 const out=await removeContributions(db,9);
 assert.deepEqual(out,{deleted:0,pending:1});
 assert.equal(calls[0][0],'updateMany');
 assert.equal(calls[0][1].data.expiresAt.getTime(),0);
});
test('meal slot follows IST, and the shortlist is a hint built from three signals',async()=>{
 assert.equal(mealSlotFor(new Date('2026-10-29T02:00:00Z')),'breakfast'); // 07:30 IST
 assert.equal(mealSlotFor(new Date('2026-10-29T07:00:00Z')),'lunch');     // 12:30 IST
 assert.equal(mealSlotFor(new Date('2026-10-29T11:00:00Z')),'snack');     // 16:30 IST
 assert.equal(mealSlotFor(new Date('2026-10-29T16:00:00Z')),'dinner');    // 21:30 IST
 const rows=[{id:1},{id:2},{id:3},{id:4}];
 const seen=[];
 const db={foodLog:{groupBy:async({where})=>{seen.push(where);return where.userId?[{foodItemId:1}]:where.slot?[{foodItemId:2}]:[{foodItemId:3}];}}};
 const picked=await shortlistRows(db,{userId:5,catalogueRows:rows,now:new Date('2026-10-29T02:00:00Z'),enabled:true});
 assert.deepEqual(picked.map(r=>r.id),[1,2,3]);
 assert.equal(seen[1].slot,'breakfast');
});
test('with the shortlist off, the whole catalogue goes most-logged first, then alphabetical',async()=>{
 resetPopularityCache();
 const rows=[{id:1,name:'A'},{id:2,name:'B'},{id:3,name:'C'}];
 const db={foodLog:{groupBy:async()=>[{foodItemId:3,_count:{foodItemId:9}},{foodItemId:2,_count:{foodItemId:1}}]}};
 const ordered=await shortlistRows(db,{userId:5,catalogueRows:rows,now:new Date('2026-10-29T00:00:00Z'),enabled:false});
 assert.deepEqual(ordered.map(r=>r.id),[3,2,1]);
 assert.deepEqual(rows.map(r=>r.id),[1,2,3],'the input list is not reordered in place');
 // A failed count falls back to the catalogue order instead of failing the photo.
 resetPopularityCache();
 const failing={foodLog:{groupBy:async()=>{throw new Error('down');}}};
 assert.deepEqual((await shortlistRows(failing,{userId:5,catalogueRows:rows,enabled:false})).map(r=>r.id),[1,2,3]);
});
test('pass rule: not worse than the current setup on precision or unknown foods',()=>{
 const rules={precisionLower:.9,minCoverage:.3};
 const good={precision95:[.95,.99],precision:.97,coverage:.5,dietaryErrors:0,totalCostUsd:1,unknownFalseAccepts:0};
 assert.equal(passes(good,{precision:.96,unknownFalseAccepts:0},rules),true);
 assert.equal(passes(good,{precision:.98,unknownFalseAccepts:0},rules),false);
 assert.equal(passes({...good,unknownFalseAccepts:1},{precision:.9,unknownFalseAccepts:0},rules),false);
 assert.equal(passes({...good,dietaryErrors:1},null,rules),false);
});
