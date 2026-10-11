import { PrismaClient } from '@prisma/client';
import { upsertDevice, listUserIdsForInstall, listInstallIdsForUser } from '../services/deviceService.js';

const prisma = new PrismaClient();

// POST /devices (verifyToken) — the app registers/refreshes the current install
// after sign-in. Upsert on (userId, installId); 204, no body.
export async function registerDevice(req, res) {
  try {
    const userId = Number(req.user?.id ?? req.headers['x-user-id']);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { installId, platform } = req.body || {};
    if (typeof installId !== 'string' || installId.trim().length === 0) {
      return res.status(400).json({ error: 'installId is required' });
    }

    await upsertDevice(prisma, {
      userId,
      installId: installId.trim(),
      platform: typeof platform === 'string' ? platform : null,
    });

    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
}

// GET /internal/devices/:installId/users (requireInternal) -> { userIds: [Int] }
export async function getUsersForInstall(req, res) {
  try {
    const userIds = await listUserIdsForInstall(prisma, String(req.params.installId));
    res.json({ userIds });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
}

// GET /internal/users/:id/devices (requireInternal) -> { installIds: [String] }
export async function getDevicesForUser(req, res) {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const installIds = await listInstallIdsForUser(prisma, userId);
    res.json({ installIds });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
}
