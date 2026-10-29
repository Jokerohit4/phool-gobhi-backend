#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { isoDayIST, weekStartOf, shiftDay, weekDays } from '../utils/sessionDay.js';
import { behavioralAverageForSnapshots } from '../services/ledger/behavioralAverage.js';

const THRESHOLD = 80;
function winners(rows, evaluationDates) {
  const oldWinners = new Set(), newWinners = new Set();
  for (const today of evaluationDates) {
    const from = shiftDay(today, -7);
    const byUser = new Map();
    for (const row of rows) {
      if (row.localDate < from || row.localDate >= today) continue;
      if (!byUser.has(row.userId)) byUser.set(row.userId, []);
      byUser.get(row.userId).push(row);
    }
    for (const [id, userRows] of byUser) {
      const old = behavioralAverageForSnapshots(userRows, { useClosedDays: false }).avgScore;
      const proposed = behavioralAverageForSnapshots(userRows, { useClosedDays: true }).avgScore;
      if (old >= THRESHOLD) oldWinners.add(id);
      if (proposed !== null && proposed >= THRESHOLD) newWinners.add(id);
    }
  }
  return {
    oldAtOrAbove80: oldWinners.size, newAtOrAbove80: newWinners.size,
    crossedUp: [...newWinners].filter(id => !oldWinners.has(id)).length,
    crossedDown: [...oldWinners].filter(id => !newWinners.has(id)).length,
  };
}
export function comparisonRange(today = isoDayIST()) {
  const end = weekStartOf(today);
  return { from: shiftDay(end, -35), end };
}
export function compareBehavioralAverages(rows, today = isoDayIST()) {
  const current = weekStartOf(today);
  return Array.from({ length: 4 }, (_, i) => {
    const weekStart = shiftDay(current, -28 + i * 7);
    // Rewards run daily on a rolling seven-closed-day window. Report both the
    // completed week's window and distinct users eligible at any run that week.
    return {
      weekStart, weekEnd: shiftDay(weekStart, 6),
      completedWeek: winners(rows, [shiftDay(weekStart, 7)]),
      anyDailyRunInWeek: winners(rows, weekDays(weekStart)),
    };
  });
}
export async function main() {
  if (!process.env.DATABASE_URL) throw Error('An explicit DATABASE_URL is required; no dotenv files are loaded');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Enforced by Postgres, not just by this script promising to issue SELECT.
    await client.query('BEGIN READ ONLY');
    const {from,end} = comparisonRange();
    const {rows} = await client.query(
      'SELECT "userId", "localDate", "close" FROM "health"."ScoreDaySnapshot" WHERE "localDate" >= $1 AND "localDate" < $2 ORDER BY "userId", "localDate"',
      [from,end],
    );
    console.log(JSON.stringify({ threshold: THRESHOLD, weeks: compareBehavioralAverages(rows) }, null, 2));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
