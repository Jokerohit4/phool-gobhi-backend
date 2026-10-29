import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

let server, base, getWeekSummary, getDayTotals;
let flags, layers, logs, water, snapshots, healthGoal, sessions, cacheValue, cacheWrites, calls;
let basic = true;
const dates = ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30'];
const history = [{effectiveFrom:'2026-10-01',kcal:2000,waterMl:2000},{effectiveFrom:'2026-10-28',kcal:1800,waterMl:2500}];
const prisma = {
  foodLog:{findMany:async ({where}) => { calls.push(['food',where]); return logs.filter(l => typeof where.localDate === 'string' ? l.localDate===where.localDate : where.localDate.in.includes(l.localDate)); }},
  waterLog:{groupBy:async ({where}) => {calls.push(['water',where]);return water.filter(r=>where.localDate.in.includes(r.localDate));}},
  scoreDaySnapshot:{findMany:async ({where}) => snapshots.filter(s=>where.localDate.in.includes(s.localDate))},
  workoutSession:{findMany:async ({where}) => {calls.push(['workouts',where]);return sessions.filter(s=>where.localDate.in.includes(s.localDate));}},
  nutritionTarget:{findMany:async()=>history},
  healthGoal:{findUnique:async()=>healthGoal},
  journeyProgress:{findUnique:async()=>({unlocked:[{layer:1},{layer:2}]})},
};
function reset() {
  flags = {coachJourney:true,weeklySummary:true,healthMetrics:true,healthLedger:true};
  layers = ['workout','water','food']; basic=true; calls=[]; cacheValue=null; cacheWrites=[];
  logs = dates.flatMap(localDate => ['breakfast','lunch'].map(slot=>({localDate,slot,nutrients:{kcal:900}})));
  water = dates.map(localDate=>({localDate,_sum:{ml:2200}}));
  snapshots = dates.slice(0,4).map(localDate=>({localDate,paused:false,planSummary:{done:2,total:3,targetHit:false}}));
  healthGoal=null; sessions=[{localDate:dates[0]},{localDate:dates[0]},{localDate:dates[2]}];
}
const cache = {get:async()=>cacheValue,set:async(...args)=>{cacheWrites.push(args);cacheValue=args[1];}};
before(async (t) => {
  reset();
  t.mock.module('@prisma/client',{exports:{PrismaClient:class {constructor(){return prisma;}}}});
  t.mock.module('../middleware/requireAuth.js',{exports:{requireAuth:(req,res,next)=>{if(req.headers['x-user-id']){req.userId=Number(req.headers['x-user-id']);next();}else res.sendStatus(401);}}});
  t.mock.module('../middleware/requireFeatureFlag.js',{exports:{
    isFeatureEnabled:async flag=>!!flags[flag],
    requireFeatureFlag:flag=>async(req,res,next)=>flags[flag]?next():res.status(403).json({error:'FEATURE_DISABLED'}),
  }});
  t.mock.module('../services/coachConsentService.js',{exports:{hasCoachScopeService:async()=>basic}});
  t.mock.module('../services/plan/layerState.js',{exports:{
    getLayers:async()=>[],
    getOnLayerKeys:async()=>layers,
  }});
  t.mock.module('../services/plan/rowProgress.js',{exports:{resolveDay:async(_db,{localDate})=>{assert.equal(localDate,'2026-10-30');return {counts:{done:1,total:3},earned:10,target:30};}}});
  t.mock.module('../services/goalService.js',{exports:{resolveGoalService:async(_id,options)=>{assert.equal(options.persist,false);return {sessionsPerWeek:4,source:'user'};}}});
  t.mock.module('../services/journey/showedUpDays.js',{exports:{getShowedUpDays:async()=>sessions.map(s=>s.localDate)}});
  t.mock.module('../utils/redisClient.js',{defaultExport:cache});
  ({getWeekSummary}=await import('../services/weekSummaryService.js'));
  ({getDayTotals}=await import('../services/ledger/nutritionService.js'));
  const router = (await import('../routes/weekSummary.js')).default;
  const app=express();app.use(router);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  // A fixed instant makes exported fixtures stable and verifies the IST clock.
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-30T10:00:00Z')});
});
after(async()=>{await new Promise(resolve=>server.close(resolve));});
async function request(query='',authenticated=true) {
  const res=await fetch(`${base}/week-summary${query}`,{headers:authenticated?{'x-user-id':'7'}:{}});
  return {status:res.status,body:res.status===401?null:await res.json()};
}
function fixture(name, body) {
  const dir=new URL('./fixtures/week_summary/',import.meta.url);mkdirSync(dir,{recursive:true});
  const file=new URL(`${name}.json`,dir);
  if(process.env.UPDATE_WEEK_SUMMARY_FIXTURES==='1') writeFileSync(file,JSON.stringify(body,null,2)+'\n');
  assert.deepEqual(body,JSON.parse(readFileSync(file,'utf8')));
}

test('contract gates authentication and both feature flags',async()=>{
  reset();assert.equal((await request('',false)).status,401);
  for(const flag of ['coachJourney','weeklySummary']){reset();flags[flag]=false;assert.equal((await request()).status,403);}
});
test('contract rejects malformed, non-Monday, repeated and future week values',async()=>{
  reset();for(const query of ['?week=','?week=2026-02-30','?week=2026-10-27','?week=2026-11-02','?week=2026-10-26&week=2026-10-19']) assert.equal((await request(query)).status,400,query);
});
test('current_week fixture, historical targets, summed parity and counted workout query',async()=>{
  reset();const {status,body}=await request();assert.equal(status,200);fixture('current_week',body);
  assert.equal(body.data.daysElapsed,5);assert.equal(body.data.nextWeek,null);
  assert.equal(body.data.days[0].food.targetKcal,2000);assert.equal(body.data.days[2].food.targetKcal,1800);
  assert.equal(body.data.days[4].food.status,'in_progress');assert.equal(body.data.days[5].food,null);
  assert.equal(body.data.totals.workouts.completed,3);
  assert.equal(body.data.totals.food.weekTargetKcal,7600);
  assert.equal(body.data.days[0].food.kcal,(await getDayTotals(prisma,7,dates[0])).totals.kcal);
  const where=calls.find(c=>c[0]==='workouts')[1];assert.equal(where.userId,7);assert.ok(where.exercises.some.sets.some.completed);
  assert.equal(cacheWrites[0][0],'health:week:7:2026-10-26');assert.equal(cacheWrites[0][3],60);
});
test('past_week fixture uses snapshots exclusively, legacy unknowns and 600 second cache',async()=>{
  reset();snapshots=[{localDate:'2026-10-19',paused:false}];const {body}=await request('?week=2026-10-19');fixture('past_week',body);
  assert.equal(body.data.daysElapsed,7);assert.equal(body.data.days[0].plan.source,'snapshot');assert.equal(body.data.days[0].plan.targetHit,null);
  assert.equal(body.data.totals.plan.total,null);assert.equal(body.data.nextWeek,'2026-10-26');assert.equal(cacheWrites[0][3],600);
});
test('no_food_layer fixture omits food from days/totals and performs no food query',async()=>{
  reset();flags.healthLedger=false;const {body}=await request();fixture('no_food_layer',body);
  assert.ok(!body.data.layers.includes('food'));assert.ok(!('food' in body.data.totals));
  for(const day of body.data.days)assert.ok(!('food' in day));assert.ok(!calls.some(c=>c[0]==='food'));
});
test('paused_days fixture excludes paused days from every daily denominator',async()=>{
  reset();snapshots[1].paused=true;healthGoal={pausedFrom:'2026-10-30',pausedUntil:'2026-11-01'};
  const {body}=await request();fixture('paused_days',body);assert.equal(body.data.pausedDays,2);
  for(const layer of ['plan','food','water'])assert.equal(body.data.totals[layer].denominatorDays,3);
});
test('empty_week fixture',async()=>{
  reset();logs=[];water=[];snapshots=[];sessions=[];const {body}=await request();fixture('empty_week',body);
  assert.equal(body.data.totals.food.daysComplete,0);assert.equal(body.data.totals.food.avgKcalCompleteDays,null);
});
test('cache cannot expose withdrawn food or coach consent',async()=>{
  reset();await request();layers=['workout','water'];const {body}=await request();assert.ok(!body.data.layers.includes('food'));
  basic=false;const response=await request();assert.deepEqual(response.body.data.layers,[]);assert.deepEqual(response.body.data.totals,{});
});
test('service survives cache outage and retains pending photos as partial',async()=>{
  reset();logs[0].nutrients={unknown:true};
  const data=await getWeekSummary(prisma,{userId:7},{cache:{get:async()=>{throw Error('offline');},set:async()=>{throw Error('offline');}}});
  assert.equal(data.days[0].food.status,'partial');assert.equal(data.days[0].food.pendingCount,1);assert.equal(data.totals.food.daysComplete,3);
});


test('food flag withdrawal omits cached food and skips its range query for either flag',async()=>{
  for(const flag of ['healthMetrics','healthLedger']) {
    reset();await request();flags[flag]=false;calls=[];
    const {status,body}=await request();assert.equal(status,200);
    assert.ok(!body.data.layers.includes('food'),flag);assert.ok(!('food' in body.data.totals),flag);
    for(const day of body.data.days)assert.ok(!('food' in day),flag);
    assert.ok(!calls.some(c=>c[0]==='food'),flag);
  }
});

test('a day under a doctor plan is judged against the doctor kcal target',async()=>{
  reset();
  const doctorPlan=async(_p,_u,day)=>day===dates[0]?{id:5,startsOn:day,endsOn:day,targets:{kcal:4321}}:null;
  const data=await getWeekSummary(prisma,{userId:7},{cache:{get:async()=>null,set:async()=>{}},doctorPlan});
  assert.equal(data.days[0].food.targetKcal,4321);
  assert.notEqual(data.days[1].food?.targetKcal,4321);
});
