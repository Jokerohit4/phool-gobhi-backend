import { ROLES } from '../constants/userEnums.js';
import prisma from '../db/prisma.js';
import { eraseAccount, eraseExploreData } from '../services/authService.js';
import { eraseUserAcrossServices } from '../utils/eraseAcrossServices.js';

const categories = new Map([
  ['health', { label: 'Health, nutrition and workouts', service: 'health-service' }],
  ['buddy', { label: 'Buddy profile, connections and chats', service: 'buddy-service' }],
  ['challenges', { label: 'Challenges, streaks and coins', service: 'challenge-service' }],
  ['coaching', { label: 'Coaching membership and fulfillment', service: 'wallet-service' }],
  ['explore', { label: 'Explore progress and receipts', erase: eraseExploreData }],
  ['addresses', { label: 'Saved addresses', erase: (userId) => prisma.savedAddress.deleteMany({ where: { userId } }) }],
]);

function isDev() {
  return process.env.K_SERVICE === 'auth-service-dev';
}

export function adminUserDataCategories() {
  if (!isDev()) return [];
  return Array.from(categories, ([id, { label }]) => ({ id, label }));
}

export async function deleteAdminUserData(req, res) {
  if (!isDev()) return res.status(404).json({ error: 'Not found' });

  const { id, scope } = req.params;
  const userId = Number(id);
  const category = categories.get(scope);
  if (!/^\d+$/.test(id) || userId < 1 || userId > 2147483647 || (!category && scope !== 'all')) {
    return res.status(400).json({ error: 'Invalid user or data category' });
  }

  const audit = { actorId: req.user.id, userId, scope };
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user?.role !== ROLES.CUSTOMER) return res.status(404).json({ error: 'Customer account not found' });

    if (scope === 'all') {
      await eraseAccount(userId);
    } else if (category.erase) {
      await category.erase(userId);
    } else {
      const result = await eraseUserAcrossServices(userId, category.service);
      if (!result.ok) throw Object.assign(new Error('Category erasure was incomplete'), { status: 502 });
    }

    console.info('Admin user data deletion completed', audit);
    return res.json({ message: scope === 'all' ? 'Customer account deleted' : `${category.label} deleted` });
  } catch (err) {
    console.error('Admin user data deletion failed', audit, err);
    return res.status(err.status === 502 ? 502 : 500).json({ error: 'Could not confirm deletion' });
  }
}
