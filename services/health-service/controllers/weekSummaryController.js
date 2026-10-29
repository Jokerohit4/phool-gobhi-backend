import { PrismaClient } from '@prisma/client';
import { getWeekSummary } from '../services/weekSummaryService.js';
const prisma = new PrismaClient();
export async function weekSummary(req, res) {
  try {
    return res.json({ data: await getWeekSummary(prisma, { userId: req.userId, week: req.query.week }) });
  } catch (err) {
    if (!err.status || err.status >= 500) console.error('[week-summary]', err);
    return res.status(err.status ?? 500).json({ error: err.status ? err.error ?? err.message : 'Server error', ...(err.code ? { code: err.code } : {}) });
  }
}
