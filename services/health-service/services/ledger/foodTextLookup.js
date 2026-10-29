import { canonicalFoodName, foodQueryTerms } from './foodNames.js';
import * as nutritionService from './nutritionService.js';
import { normaliseFoodEstimate } from './foodPhotoCatalogue.js';
import { compositionForFood, isGenericFoodName } from './foodComposition.js';
import { buildSearchText } from './foodMatch.js';
import { recognizeFood, candidates } from './providers/index.js';
import { measuredCall } from './photoMeasurement.js';
const normalized = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
async function withQueryLock(key, work) {
  const {pool}=await import('../../db.js');
  const client=await pool.connect();let locked=false;
  try {
    await client.query("SET lock_timeout = '25s'");
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);locked=true;
    return await work();
  } finally {
    try {
      if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
      await client.query('RESET lock_timeout');client.release();
    } catch {client.release(true);}
  }
}

// POST only: ordinary catalogue/ingredient/typeahead GETs never call a model.
export async function lookupFood(prisma,userId,query,deps={}) {
  const search=deps.search || nutritionService.searchFoods;
  const q=normalized(query);
  if(q.length<3 || q.length>80 || !/\p{L}/u.test(q)) return [];
  const existing=await search(prisma,userId,{query:q,includeUnverified:true});
  if(existing.length)return existing;
  if(process.env.FOOD_TEXT_AI_LOOKUP!=='true' || isGenericFoodName(q))return [];
  return (deps.withLock || withQueryLock)(`text-food:${userId}`,async()=>{
    const cached=await search(prisma,userId,{query:q,includeUnverified:true});
    if(cached.length)return cached;
    const count=await prisma.foodPhotoUsage.count({where:{userId,stage:'text_lookup',requestedAt:{gte:new Date(Date.now()-3600000)}}});
    if(count>=20)throw Object.assign(new Error('Too many food lookups. Try again later.'),{status:429});
    let proposal;
    const maxAttempts=deps.maxAttempts ?? (deps.recognize ? 1 : Math.max(1,Math.min(2,candidates().length)));
    for(let attempt=1;attempt<=maxAttempts;attempt++) {
      if(count+attempt-1>=20)throw Object.assign(new Error('Too many food lookups. Try again later.'),{status:429});
      try {
        proposal=await measuredCall(prisma,userId,'text_lookup',()=> (deps.recognize || recognizeFood)({
          enrichmentName:canonicalFoodName(q), textLookup:true,
        },{attempt}));
        break;
      } catch(error) {
        // One bounded failover through the existing rotation on transient failure.
        // Each attempted call gets its own usage row; semantic misses are not retried.
        if(!error.retryable || attempt===maxAttempts)throw Object.assign(new Error('Could not look up that food. Please try again.'),{status:502});
      }
    }
    if(!proposal.isFood || proposal.items?.length!==1)return [];
    const item=proposal.items[0];
    const nutrition=normaliseFoodEstimate(item.nutrition);
    if(!nutrition || !item.ingredients?.length || isGenericFoodName(item.name))return [];
    // Do not substitute an unrelated food when the model changed the query.
    if(![item.name,...nutrition.aliases].some(name=>foodQueryTerms(name).some(term=>foodQueryTerms(q).includes(term))))return [];
    // A catalogue item could have arrived while the paid call was running.
    const resolved=await search(prisma,userId,{query:q,includeUnverified:true});
    if(resolved.length)return resolved;
    const composition=compositionForFood(item);
    const aliases=[...new Set([...nutrition.aliases,...foodQueryTerms(q),...foodQueryTerms(item.name)])];
    const food=await prisma.foodItem.create({data:{
      name:item.name, ...nutrition, aliases, ...composition,
      veg:composition.dietaryType==='veg',nonVeg:['egg','non_veg'].includes(composition.dietaryType),
      createdByUserId:userId,source:'estimate',verified:false,
      reviewNote:'AI-estimated from a typed food lookup; review before logging.',
      searchText:buildSearchText(item.name,aliases),
    }});
    return [food];
  });
}
