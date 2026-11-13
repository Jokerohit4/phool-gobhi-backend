import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foodStatus, isCompleteFoodDay, waterMet, summarizeDays } from '../services/weekSummary/definitions.js';
const full = { logCount: 2, mealSlotsCovered: 2, pendingCount: 0, kcal: 2000, targetKcal: 2000 };
for (const [status, patch] of [
  ['unlogged',{logCount:0}], ['partial',{mealSlotsCovered:1}], ['partial',{pendingCount:1}],
  ['on_target',{}], ['on_target',{kcal:1500}], ['on_target',{kcal:2500}],
  ['under',{kcal:1499}], ['over',{kcal:2501}], ['no_target',{targetKcal:null}],
  ['no_target',{targetKcal:0}], ['in_progress',{isToday:true,logCount:0}],
]) test(`food ${status}: ${JSON.stringify(patch)}`, () => assert.equal(foodStatus({...full,...patch}),status));
test('completeness and water boundaries', () => {
  for (const status of ['on_target','under','over','no_target']) assert.equal(isCompleteFoodDay(status),true);
  for (const status of ['in_progress','partial','unlogged']) assert.equal(isCompleteFoodDay(status),false);
  assert.equal(waterMet(2500,2500),true);
  assert.equal(waterMet(2499,2500),false);
  assert.equal(waterMet(2500,null),false);
});
test('totals exclude paused and future days; today counts in denominator but not completion', () => {
  const day = {plan:{done:1,total:2,targetHit:false,source:'snapshot'}, food:{status:'on_target',logCount:2,kcal:1800,targetKcal:2000},water:{ml:2500,met:true}};
  const days = [day, {...day,paused:true}, {...day,isFuture:true}, {...day,isToday:true,food:{...day.food,status:'in_progress'}}];
  const totals = summarizeDays(days,['plan','food','water'],null,0);
  assert.equal(totals.food.denominatorDays,2);
  assert.equal(totals.food.daysLogged,2);
  assert.equal(totals.food.daysComplete,1);
  assert.equal(totals.food.weekKcal,1800);
  assert.equal(totals.food.weekTargetKcal,2000);
  assert.equal(totals.food.avgKcalCompleteDays,1800);
  assert.equal(totals.water.daysMet,1);
  assert.equal(totals.plan.done,2);
});
test('unknown plan history and no eligible food are not invented zeros', () => {
  const out = summarizeDays([{plan:{done:null,total:null,targetHit:null,source:'snapshot'},food:{status:'unlogged',logCount:0},water:{ml:0,met:false}}], ['plan','food','water'],null,0);
  assert.equal(out.plan.done,null);
  assert.equal(out.food.avgKcalCompleteDays,null);
  assert.deepEqual(summarizeDays([],[],null,0),{});
});


test('closedDays denominators and averages exclude today even if it already meets every target', () => {
  const day = { plan:{done:1,total:1,targetHit:true,source:'snapshot'},
    food:{status:'on_target',logCount:2,kcal:1800,targetKcal:2000},water:{ml:2000,met:true} };
  const today = {...day,isToday:true,food:{...day.food,kcal:5000},water:{ml:9000,met:true}};
  const days = [day, today, {...day,paused:true}, {...day,isFuture:true}];
  const totals = summarizeDays(days,['plan','food','water','workouts'],{sessionsPerWeek:3,source:'user'},1);
  for (const layer of ['plan','food','water','workouts']) assert.equal(totals[layer].closedDays,1,layer);
  for (const layer of ['plan','food','water']) assert.equal(totals[layer].denominatorDays,2,layer);
  assert.equal(totals.plan.daysTargetHit,1);
  assert.equal(totals.food.daysComplete,1); assert.equal(totals.food.daysOnTarget,1);
  assert.equal(totals.food.avgKcalCompleteDays,1800); assert.equal(totals.water.avgMl,2000);
  assert.equal(totals.water.daysMet,1);
  const onlyToday = summarizeDays([today],['plan','food','water'],null,0);
  assert.equal(onlyToday.food.closedDays,0); assert.equal(onlyToday.plan.daysTargetHit,0);
  assert.equal(onlyToday.water.avgMl,null); assert.equal(onlyToday.food.avgKcalCompleteDays,null);
});
test('past-week closedDays equal eligible elapsed days', () => {
  const day = {plan:{done:0,total:1,targetHit:false},food:{status:'unlogged',logCount:0},water:{ml:0,met:false}};
  const totals=summarizeDays([...Array(7)].map(()=>({...day})),['plan','food','water'],null,0);
  for(const layer of ['plan','food','water']) {
    assert.equal(totals[layer].closedDays,7); assert.equal(totals[layer].denominatorDays,7);
  }
});
