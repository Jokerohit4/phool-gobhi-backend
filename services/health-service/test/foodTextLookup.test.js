import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {lookupFood} from '../services/ledger/foodTextLookup.js';
const old=process.env.FOOD_TEXT_AI_LOOKUP;
afterEach(()=>{if(old==null)delete process.env.FOOD_TEXT_AI_LOOKUP;else process.env.FOOD_TEXT_AI_LOOKUP=old;});
function fixture(){
 const rows=[],usage=[];let calls=0,tail=Promise.resolve();
 const db={foodPhotoUsage:{count:async()=>usage.length,create:async({data})=>usage.push(data)},foodItem:{create:async({data})=>{const row={id:99,...data};rows.push(row);return row;}}};
 const deps={search:async()=>rows,withLock:async(_key,work)=>{const before=tail;let done;tail=new Promise(r=>done=r);await before;try{return await work();}finally{done();}},recognize:async()=>{calls++;return {isFood:true,model:'test',items:[{name:'Dhokla',dietaryType:'veg',ingredients:[{name:'Gram flour',grams:100,dietaryType:'veg'}],nutrition:{kcal:160,proteinG:6,carbsG:25,fatG:4,fibreG:2,servings:[{label:'piece',grams:50}]}}]};}};
 return {db,deps,rows,usage,get calls(){return calls;}};
}
test('database matches avoid AI even when enabled',async()=>{const f=fixture();process.env.FOOD_TEXT_AI_LOOKUP='true';f.rows.push({id:1});assert.equal((await lookupFood(f.db,7,'Dhokla',f.deps))[0].id,1);assert.equal(f.calls,0);});
test('concurrent misses call once, save a private estimate and reuse it',async()=>{const f=fixture();process.env.FOOD_TEXT_AI_LOOKUP='true';const rows=await Promise.all([lookupFood(f.db,7,'Dhokla',f.deps),lookupFood(f.db,7,'Dhokla',f.deps)]);assert.equal(f.calls,1);assert.equal(rows[0][0].createdByUserId,7);assert.equal(rows[0][0].verified,false);assert.equal(f.usage[0].stage,'text_lookup');assert.equal(rows[0][0].ironMg,null);});
test('disabled, partial and ambiguous names make no paid call',async()=>{const f=fixture();for(const q of ['Dhokla','ab','burger']){delete process.env.FOOD_TEXT_AI_LOOKUP;assert.deepEqual(await lookupFood(f.db,7,q,f.deps),[]);}process.env.FOOD_TEXT_AI_LOOKUP='true';assert.deepEqual(await lookupFood(f.db,7,'burger',f.deps),[]);assert.equal(f.calls,0);});
test('unknown or invalid nutrition is never inserted; usage remains recorded',async()=>{const f=fixture();process.env.FOOD_TEXT_AI_LOOKUP='true';f.deps.recognize=async()=>({isFood:true,items:[{name:'Dhokla',nutrition:{kcal:0}}]});assert.deepEqual(await lookupFood(f.db,7,'Dhokla',f.deps),[]);assert.equal(f.rows.length,0);assert.equal(f.usage.length,1);});
test('hourly budget refuses additional paid lookups',async()=>{const f=fixture();process.env.FOOD_TEXT_AI_LOOKUP='true';f.db.foodPhotoUsage.count=async()=>20;await assert.rejects(lookupFood(f.db,7,'Dhokla',f.deps),{status:429});assert.equal(f.calls,0);});

test('transient provider failure rotates once and records both attempts',async()=>{
 const f=fixture();process.env.FOOD_TEXT_AI_LOOKUP='true';const good=f.deps.recognize;const attempts=[];
 f.deps.maxAttempts=2;f.deps.recognize=async(payload,options)=>{attempts.push(options.attempt);if(options.attempt===1)throw Object.assign(new Error('busy'),{retryable:true});return good(payload);};
 const result=await lookupFood(f.db,7,'Dhokla',f.deps);
 assert.equal(result.length,1);assert.deepEqual(attempts,[1,2]);assert.equal(f.usage.length,2);assert.equal(f.usage[0].outcome,'error');
});

test('laung AI lookup asks for clove and saves English and Hinglish aliases for reuse',async()=>{
 const f=fixture();process.env.FOOD_TEXT_AI_LOOKUP='true';let requested;
 const original=f.deps.recognize;
 f.deps.recognize=async payload=>{requested=payload.enrichmentName;const result=await original();result.items[0].name='Clove';result.items[0].ingredients=[{name:'Clove',grams:100,dietaryType:'veg'}];return result;};
 const rows=await lookupFood(f.db,7,'laung',f.deps);
 assert.equal(requested,'clove');assert.equal(rows[0].name,'Clove');assert.ok(rows[0].aliases.includes('laung'));assert.ok(rows[0].aliases.includes('clove'));
 await lookupFood(f.db,7,'clove',f.deps);assert.equal(f.calls,1);
});
