import prisma from '../db/prisma.js';

const userId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;
const cohorts = new Set(['FRIENDS_AND_FAMILY', 'GENERATED_ACCOUNTS', 'TESTING_ACCOUNTS', 'UNKNOWN_USERS']);

export async function getNotificationCustomers(req, res) {
  const { ids, audience, after = 0, limit = 250, includeTokens = false } = req.body ?? {};
  const where = { role: 'customer', isActive: true, archivedAt: null };
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 250 || !ids.every(userId)) {
      return res.status(400).json({ error: 'Invalid customer IDs' });
    }
    where.id = { in: ids };
  } else {
    if (!audience || !['all', 'cohorts', 'users'].includes(audience.type) ||
        (after !== 0 && !userId(after)) || !Number.isInteger(limit) || limit < 1 || limit > 250 || includeTokens) {
      return res.status(400).json({ error: 'Invalid audience page' });
    }
    where.id = { gt: after };
    // A selected ID still appears in delivery history when it has no token.
    if (audience.type !== 'users') where.fcmToken = { not: '' };
    if (audience.type === 'users') {
      if (!Array.isArray(audience.userIds) || audience.userIds.length > 1000 || !audience.userIds.every(userId)) {
        return res.status(400).json({ error: 'Invalid selected audience' });
      }
      where.id.in = audience.userIds;
    }
    if (audience.type === 'cohorts') {
      if (!Array.isArray(audience.cohorts) || !audience.cohorts.length || !audience.cohorts.every(value => cohorts.has(value))) {
        return res.status(400).json({ error: 'Invalid cohorts' });
      }
      where.accountCohort = { in: audience.cohorts };
    }
  }
  const data = await prisma.user.findMany({
    where, select: { id: true, accountCohort: true, fcmToken: includeTokens === true },
    orderBy: { id: 'asc' }, take: ids === undefined ? limit : ids.length,
  });
  res.json({ data });
}
