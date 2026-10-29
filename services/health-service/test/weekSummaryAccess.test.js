import { test } from 'node:test';
import assert from 'node:assert/strict';
let basic=true, onKeys=['workout','water','food'], read=0;
const flags={healthMetrics:true,healthLedger:true};
test('access honors current consent, persisted unlocks and wellness layer filtering without journey mutations', async t=>{
  t.mock.module('../middleware/requireFeatureFlag.js',{exports:{isFeatureEnabled:async flag=>!!flags[flag]}});
  t.mock.module('../services/coachConsentService.js',{exports:{hasCoachScopeService:async()=>basic}});
  t.mock.module('../services/plan/layerState.js',{exports:{
    getLayers:async(_db,_id,{journey})=>{assert.equal(journey.layers[0].unlocked,true);return [];},
    getOnLayerKeys:async()=>onKeys,
  }});
  const {weekSummaryAccess}=await import('../services/weekSummaryService.js');
  const db={journeyProgress:{findUnique:async()=>{read++;return {unlocked:[{layer:1,at:'2026-10-01'}]};}}};
  assert.deepEqual((await weekSummaryAccess(db,7)).layers,['plan','food','water','workouts']);
  // The layer resolver deliberately still supplies food, so these checks prove
  // the summary's own gate omits both the wire layer and live resolver key.
  for(const flag of ['healthMetrics','healthLedger']) {
    flags[flag]=false;
    const access=await weekSummaryAccess(db,7);
    assert.deepEqual(access.layers,['plan','water','workouts'],flag);
    assert.ok(!access.onLayerKeys.includes('food'),flag);
    flags[flag]=true;
  }
  assert.ok((await weekSummaryAccess(db,7)).layers.includes('food'));
  onKeys=['water'];assert.deepEqual((await weekSummaryAccess(db,7)).layers,['plan','water']);
  basic=false;const before=read;assert.deepEqual((await weekSummaryAccess(db,7)).layers,[]);assert.equal(read,before);
});
