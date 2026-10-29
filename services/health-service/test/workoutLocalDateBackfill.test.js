import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backfillWorkoutLocalDates } from '../scripts/backfill-workout-local-date.mjs';
function db() {
  const rows = [
    {id:1,startedAt:new Date('2026-10-25T18:29:59Z'),localDate:null},
    {id:2,startedAt:new Date('2026-10-25T18:30:00Z'),localDate:null},
    {id:3,startedAt:new Date('2026-10-25T23:59:00Z'),localDate:'2026-10-24'},
    {id:4,startedAt:new Date('2025-12-31T20:00:00Z'),localDate:null},
  ];
  return { rows, workoutSession: {
    findMany:async({where,take})=>rows.filter(r=>r.localDate===null&&r.id>where.id.gt).slice(0,take),
    updateMany:async({where,data})=>{const row=rows.find(r=>r.id===where.id&&r.localDate===null);if(!row)return{count:0};row.localDate=data.localDate;return{count:1};},
    count:async()=>rows.filter(r=>r.localDate===null).length,
  } };
}
test('dry-run scans bounded batches and never writes',async()=>{
  const prisma=db();const before=structuredClone(prisma.rows);
  assert.deepEqual(await backfillWorkoutLocalDates(prisma,{batchSize:1}),{mode:'dry-run',scanned:3,updated:0,remaining:3});
  assert.deepEqual(prisma.rows,before);
});
test('apply uses IST midnight, preserves existing dates and is idempotent',async()=>{
  const prisma=db();assert.deepEqual(await backfillWorkoutLocalDates(prisma,{apply:true,batchSize:2}),{mode:'apply',scanned:3,updated:3,remaining:0});
  assert.deepEqual(prisma.rows.map(r=>r.localDate),['2026-10-25','2026-10-26','2026-10-24','2026-01-01']);
  assert.deepEqual(await backfillWorkoutLocalDates(prisma,{apply:true}),{mode:'apply',scanned:0,updated:0,remaining:0});
});
test('migration uses UTC timestamp conversion and updates only null dates',()=>{
  const sql=readFileSync(new URL('../prisma/migrations/20261030010000_backfill_workout_local_date/migration.sql',import.meta.url),'utf8');
  assert.match(sql,/AT TIME ZONE 'UTC'\) AT TIME ZONE/);
  assert.match(sql,/WHERE "localDate" IS NULL/);
});
