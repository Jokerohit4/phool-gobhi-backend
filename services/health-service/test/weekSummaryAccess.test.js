import { test } from 'node:test';
import assert from 'node:assert/strict';
let basic=true, onKeys=['workout','water','food'], read=0;
test('access honors current consent, persisted unlocks and wellness layer filtering without journey mutations', async t=>{
  t.mock.module('../services/coachConsentService.js',{exports:{hasCoachScopeService:async()=>basic}});
  t.mock.module('../services/plan/layerState.js',{exports:{
    getLayers:async(_db,_id,{journey})=>{assert.equal(journey.layers[0].unlocked,true);return [];},
    getOnLayerKeys:async()=>onKeys,
  }});
  const {weekSummaryAccess}=await import('../services/weekSummaryService.js');
  const db={journeyProgress:{findUnique:async()=>{read++;return {unlocked:[{layer:1,at:'2026-10-01'}]};}}};
  assert.deepEqual((await weekSummaryAccess(db,7)).layers,['plan','food','water','workouts']);
  onKeys=['water'];assert.deepEqual((await weekSummaryAccess(db,7)).layers,['plan','water']);
  basic=false;const before=read;assert.deepEqual((await weekSummaryAccess(db,7)).layers,[]);assert.equal(read,before);
});
