import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function formatUser(user) {
  return {
    authId: user.id,
    name: user.name,
    email: user.email || '',
    phone: user.phone || '',
    profileImageUrl: user.profileImageUrl || '',
    fcmToken: user.fcmToken || '',
    role: user.role,
  };
}

// POST /users — called by Flutter after signup; returns existing user profile
export const getOrCreateProfile = async (req, res) => {
  try {
    const { authId } = req.body;
    if (!authId) return res.status(400).json({ error: 'authId required' });
    const user = await prisma.user.findUnique({ where: { id: Number(authId) } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.status(201).json({ data: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// GET /users/:userId
export const getProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.userId) } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ data: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// PUT /users/:userId — update name, phone, profileImageUrl, fcmToken
export const updateProfile = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });
    const { name, phone, profileImageUrl, fcmToken } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (profileImageUrl !== undefined) updates.profileImageUrl = profileImageUrl;
    if (fcmToken !== undefined) updates.fcmToken = fcmToken;
    const user = await prisma.user.update({ where: { id: targetUserId }, data: updates });
    res.json({ data: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
