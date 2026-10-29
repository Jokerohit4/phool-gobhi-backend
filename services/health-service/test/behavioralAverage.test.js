import { test } from 'node:test';
import assert from 'node:assert/strict';
import { behavioralAverageForSnapshots } from '../services/ledger/behavioralAverage.js';
import { USE_CLOSED_DAY_BEHAVIORAL_AVERAGE } from '../services/ledger/constants.js';
import { compareBehavioralAverages, comparisonRange } from '../scripts/compare-behavioral-avg.mjs';
const rows = (n,close=500) => Array.from({length:n},()=>({close}));
test('rollout gate is on: closed days are the denominator, legacy rule still available',()=>{
  assert.equal(USE_CLOSED_DAY_BEHAVIORAL_AVERAGE,true);
  assert.deepEqual(behavioralAverageForSnapshots(rows(3)),{avgScore:null,closedDays:3});
  assert.deepEqual(behavioralAverageForSnapshots([]),{avgScore:null,closedDays:0});
  assert.deepEqual(behavioralAverageForSnapshots(rows(3),{useClosedDays:false}),{avgScore:42.9,closedDays:3});
});
test('proposed averaging needs four closed days and shares normalization/rounding',()=>{
  for(const n of [0,1,2,3])assert.deepEqual(behavioralAverageForSnapshots(rows(n),{useClosedDays:true}),{avgScore:null,closedDays:n});
  for(const n of [4,5,6,7])assert.deepEqual(behavioralAverageForSnapshots(rows(n,400),{useClosedDays:true}),{avgScore:80,closedDays:n});
  assert.equal(behavioralAverageForSnapshots([{close:1000},{close:-100},{close:400},{close:450}],{useClosedDays:true}).avgScore,67.5);
});
test('comparison reports four completed IST weeks and both weekly and rolling eligibility',()=>{
  const input = [
    ...['2026-10-19','2026-10-20','2026-10-21','2026-10-22'].map(localDate=>({userId:1,localDate,close:500})),
    ...['2026-10-19','2026-10-20','2026-10-21'].map(localDate=>({userId:2,localDate,close:500})),
    ...['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25'].map(localDate=>({userId:3,localDate,close:400})),
  ];
  const report=compareBehavioralAverages(input,'2026-10-30');
  assert.equal(report.length,4);assert.equal(report[0].weekStart,'2026-09-28');assert.equal(report[3].weekStart,'2026-10-19');
  assert.deepEqual(report[3].completedWeek,{oldAtOrAbove80:1,newAtOrAbove80:2,crossedUp:1,crossedDown:0});
  assert.deepEqual(report[3].anyDailyRunInWeek,{oldAtOrAbove80:0,newAtOrAbove80:2,crossedUp:2,crossedDown:0});
  assert.deepEqual(comparisonRange('2026-10-30'),{from:'2026-09-21',end:'2026-10-26'});
});
