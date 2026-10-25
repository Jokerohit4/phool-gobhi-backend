import { PrismaClient } from '@prisma/client';
import { bindPushToken, unbindPushToken } from '../services/pushTokenService.js';
const prisma = new PrismaClient();

export function pushTokenHandler(database, remove = false) {
  return async (req, res) => {
    const userId = req.user?.id;
    const token = req.body?.fcmToken;
    if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Unauthorized' });
    if (typeof token !== 'string' || !token.trim() || token.length > 4096) {
      return res.status(400).json({ error: 'A valid fcmToken is required' });
    }
    try {
      if (remove) await unbindPushToken(database, userId, token);
      else await bindPushToken(database, userId, token);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Push token update failed:', error.message);
      return res.status(500).json({ error: 'Could not update notification registration' });
    }
  };
}

export const registerPushToken = pushTokenHandler(prisma);
export const unregisterPushToken = pushTokenHandler(prisma, true);
