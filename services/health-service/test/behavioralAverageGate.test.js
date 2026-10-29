import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as constants from '../services/ledger/constants.js';

test('enabling the proposed rule makes card, league and coin decision agree on insufficient data', async t => {
  let rows = Array.from({length:3},()=>({userId:7,close:500}));
  const db = {
    scoreDaySnapshot: {findMany:async()=>rows,findFirst:async()=>({close:500})},
    biometricEntry:{findMany:async()=>[]},
  };
  let credits=0;
  t.mock.module('../services/ledger/constants.js',{exports:{...constants,USE_CLOSED_DAY_BEHAVIORAL_AVERAGE:true}});
  t.mock.module('@prisma/client',{exports:{PrismaClient:class {constructor(){return db;}},Prisma:{}}});
  t.mock.module('../utils/redisClient.js',{exports:{default:{get:async()=>null,set:async()=>null}}});
  t.mock.module('../utils/notifyChallengeService.js',{exports:{creditWeeklyConsistencyCoins:async()=>{credits++;return true;},notifyWorkoutFinished:async()=>{}}});
  const {getBlendedScore,getBatchBehavioralConsistency}=await import('../services/ledger/scoreService.js');
  const {evaluateUserReward}=await import('../services/rewardService.js');
  let card=await getBlendedScore(db,{userId:7});
  assert.equal(card.behavioralAvg7Day,null);assert.equal(card.closedDays,3);
  assert.deepEqual(await getBatchBehavioralConsistency(db,{userIds:[7]}),[{userId:7,avgScore:null,closedDays:3}]);
  assert.equal((await evaluateUserReward(7)).status,'ignored');assert.equal(credits,0);
  rows.push({userId:7,close:500});
  card=await getBlendedScore(db,{userId:7});assert.equal(card.behavioralAvg7Day,100);assert.equal(card.closedDays,4);
  assert.equal((await evaluateUserReward(7)).status,'rewarded');assert.equal(credits,1);
});
