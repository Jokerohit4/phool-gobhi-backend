import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const fixtures=JSON.parse(readFileSync(new URL('../exploration/contract/api-fixtures.json',import.meta.url),'utf8'));
const location=fixtures.httpCases.find(c=>c.name==='collection-location').response.body.data.history[0];
const reward=fixtures.rewardExamples[0];
let exportData;
const calls=[];
test('setup: mock Prisma + export fan-out and import account export',async t=>{
  t.mock.module('@prisma/client',{exports:{PrismaClient:class {
    constructor() {
      this.user={findUnique:async({where})=>({id:where.id,referredByUserId:null})};
      for(const name of ['savedAddress','gymLink','userDevice','exploreLocationReceipt','exploreRewardReceipt']) {
        this[name]={findMany:async args=>{
          calls.push({name,args});
          return name==='exploreLocationReceipt'?[{payload:location}]:name==='exploreRewardReceipt'?[{payload:reward}]:[];
        }};
      }
      this.platformReview={findUnique:async()=>null};
    }
  },Prisma:{}}});
  t.mock.module('../utils/exportAcrossServices.js',{exports:{exportUserAcrossServices:async()=>({sections:{},failures:[]})}});
  ({buildFullExportService:exportData}=await import('../services/exportService.js'));
});
test('account export includes both receipt classes, scopes every read and carries no proof/legacy output',async()=>{
  const data=await exportData(42);
  assert.deepEqual(data.exploration,{locationReceipts:[location],rewardReceipts:[reward]});
  assert.ok(!Object.hasOwn(data,'collectiblesFound'));
  for(const call of calls)assert.equal(call.args.where.userId,42);
  for(const key of ['position','latitude','longitude','accuracyMeters','fixAt','capturedAt','fingerprint'])assert.ok(!JSON.stringify(data.exploration).includes(key));
});
