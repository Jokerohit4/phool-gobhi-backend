// Explicitly opt-in paid replay. Run only with a disposable benchmark DB and benchmark provider credentials.
import fs from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {recognizePhoto,shortlistRows} from '../services/ledger/foodPhotoService.js';
import {validateDataset,digest} from '../services/ledger/photoEvaluation.js';
import {priceUsage} from '../services/ledger/photoMeasurement.js';
const [manifestPath,outPath,ack]=process.argv.slice(2);
if(ack!=='--paid-benchmark' || !process.env.PHOTO_BENCHMARK_DATABASE_URL || !process.env.PHOTO_BENCHMARK_PROVIDER_CANDIDATES) throw new Error('Explicit benchmark DB, provider credentials and --paid-benchmark required');
const input=JSON.parse(fs.readFileSync(manifestPath));
validateDataset(input.labels);
if(!input.pricing?.version || input.pricing.currency!=='USD' || input.pricing.tax!=='excluded' || !input.pricing.effectiveFrom || !input.pricing.effectiveTo) throw new Error('Versioned tax-exclusive pricing required');
if(new Date()<new Date(input.pricing.effectiveFrom) || new Date()>=new Date(input.pricing.effectiveTo)) throw new Error('Pricing outside validity window');
if(input.labels.some(l=>l.split!=='validation')) throw new Error('Replay accepts validation only; final holdout requires frozen release procedure');
const db=new PrismaClient({datasources:{db:{url:process.env.PHOTO_BENCHMARK_DATABASE_URL}}});
const controls=['FOOD_PHOTO_NUTRITION_MODE','FOOD_PHOTO_SHORTLIST','FOOD_PHOTO_LOW_RESOLUTION','FOOD_PHOTO_THINKING','FOOD_PHOTO_EXACT_CACHE','FOOD_PHOTO_CACHE_HOURS'];
process.env.FOOD_PHOTO_PROVIDER_CANDIDATES=process.env.PHOTO_BENCHMARK_PROVIDER_CANDIDATES;
const arms={};
try {
 for(const [id,config] of Object.entries(input.configurations)) {
 for(const name of controls) {delete process.env[name];if(config[name]!=null) process.env[name]=String(config[name]);}
 arms[id]=[];
 for(const label of input.labels) {
 const userId=Number.parseInt(digest(label.person).slice(0,7),16);
 // Was every labelled food on the hint shortlist? Undefined when the arm
 // sends the whole catalogue. Lets the report show off-shortlist accuracy.
 let shortlistHit;
 if(config.FOOD_PHOTO_SHORTLIST==='true') {
 const catalogueRows=await db.foodItem.findMany({where:{createdByUserId:null},select:{id:true}});
 const ids=new Set((await shortlistRows(db,{userId,catalogueRows,enabled:true})).map(r=>r.id));
 shortlistHit=(label.foodIds||[]).every(id=>ids.has(id));
 }
 const start=new Date();let result,failed=false;
 try {result=await recognizePhoto(db,{userId,buffer:fs.readFileSync(input.images[label.id].path),mimeType:input.images[label.id].mimeType,deps:{storage:{isAllowedMimeType:m=>['image/jpeg','image/png','image/webp'].includes(m),savePhoto:async()=>`benchmark/${userId}/${Date.now()}`,signedPhotoUrl:async()=>null}}});} catch {failed=true;}
 const latencyMs=Date.now()-start.getTime();
 const usage=await db.foodPhotoUsage.findMany({where:{userId,requestedAt:{gte:start}}});
 const costs=usage.map(u=>priceUsage(u,input.pricing.models[u.model]));
 const costUsd=usage.length && costs.every(c=>c!=null)?costs.reduce((a,b)=>a+b,0):null;
 arms[id].push({id:label.id,accepted:!failed&&!!result?.items?.length,failed,foodIds:result?.items?.map(i=>i.foodItemId)||[],dietaryType:result?.items?.every(i=>i.dietaryType==='veg')?'veg':result?.items?.some(i=>i.dietaryType==='non_veg')?'non_veg':result?.items?.some(i=>i.dietaryType==='egg')?'egg':'unknown',latencyMs,costUsd,usage,shortlistHit});
 }
 }
 fs.writeFileSync(outPath,JSON.stringify({...input,images:undefined,arms},null,2),{flag:'wx'});
} finally {await db.$disconnect();}
