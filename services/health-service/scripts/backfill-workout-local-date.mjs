#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { isoDayIST } from '../utils/sessionDay.js';

// No dotenv loading. An operator must explicitly supply the target URL.
// Dry-run by default. The migration performs the same null-only update in SQL.
export async function backfillWorkoutLocalDates(prisma, { apply = false, batchSize = 500 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw Error('batchSize must be positive');
  let lastId = 0, scanned = 0, updated = 0;
  for (;;) {
    const rows = await prisma.workoutSession.findMany({
      where: { localDate: null, id: { gt: lastId } },
      orderBy: { id: 'asc' }, take: batchSize,
      select: { id: true, startedAt: true },
    });
    if (!rows.length) break;
    for (const row of rows) {
      const localDate = isoDayIST(row.startedAt);
      scanned++;
      if (apply) {
        const result = await prisma.workoutSession.updateMany({
          where: { id: row.id, localDate: null }, data: { localDate },
        });
        updated += result.count;
      }
      lastId = row.id;
    }
  }
  const remaining = await prisma.workoutSession.count({ where: { localDate: null } });
  return { mode: apply ? 'apply' : 'dry-run', scanned, updated, remaining };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(a => a !== '--apply')) throw Error('usage: DATABASE_URL=... node scripts/backfill-workout-local-date.mjs [--apply]');
  if (!process.env.DATABASE_URL) throw Error('An explicit DATABASE_URL is required');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const result = await backfillWorkoutLocalDates(prisma, { apply: args.includes('--apply') });
    console.log(JSON.stringify(result));
    if (args.includes('--apply') && result.remaining !== 0) throw Error('Backfill incomplete; do not deploy fallback removal');
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
