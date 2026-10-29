import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumFoodLogs } from '../services/ledger/nutritionService.js';
// Opt in explicitly against a disposable test DB. Never uses DATABASE_URL.
const url = process.env.RUN_WEEK_SUMMARY_DB_TESTS === '1' && process.env.TEST_DATABASE_URL;
test('week range isolates user/date and preserves unknown nutrient snapshots', {skip: !url && 'requires explicit disposable TEST_DATABASE_URL opt-in'}, async () => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({datasourceUrl:url});
  const userId=9_300_001;
  try {
    // Roll back all fixtures, including on assertion failure.
    const rollback=Symbol('rollback');
    try { await prisma.$transaction(async tx=>{
      await tx.foodLog.createMany({data:[
        {userId,localDate:'2026-10-26',slot:'breakfast',name:'Range fixture',grams:100,nutrients:{kcal:900},source:'search'},
        {userId,localDate:'2026-10-26',slot:'lunch',name:'Pending fixture',grams:100,nutrients:{unknown:true},source:'photo_unmatched'},
        {userId,localDate:'2026-10-25',slot:'lunch',name:'Outside range',grams:100,nutrients:{kcal:500},source:'search'},
        {userId:userId+1,localDate:'2026-10-26',slot:'lunch',name:'Other user',grams:100,nutrients:{kcal:500},source:'search'},
      ]});
      const rows=await tx.foodLog.findMany({where:{userId,localDate:{in:['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']}}});
      const summed=sumFoodLogs(rows);
      assert.equal(summed.logCount,2);assert.equal(summed.pendingCount,1);assert.equal(summed.totals.kcal,900);
      throw rollback;
    }); } catch(err){if(err!==rollback)throw err;}
  } finally {await prisma.$disconnect();}
});
