import { PrismaClient } from '@prisma/client';
import { VALID_GENDERS, VALID_FITNESS_GOALS } from '../constants/userEnums.js';

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
    gender: user.gender || null,
    dateOfBirth: user.dateOfBirth || null,
    fitnessGoals: user.fitnessGoals || [],
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

// POST /users/:userId/profile-picture — multipart upload (field "image"),
// stores to Cloudinary and persists the resulting URL.
export const uploadProfilePicture = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const user = await prisma.user.update({
      where: { id: targetUserId },
      data: { profileImageUrl: req.file.path },
    });
    res.status(201).json({ data: formatUser(user) });
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
    const { name, phone, profileImageUrl, fcmToken, email, gender, dateOfBirth, fitnessGoals } = req.body;

    if (gender !== undefined && gender !== null && !VALID_GENDERS.includes(gender)) {
      return res.status(400).json({ error: `Invalid gender. Must be one of: ${VALID_GENDERS.join(', ')}` });
    }
    if (fitnessGoals !== undefined && fitnessGoals !== null) {
      if (!Array.isArray(fitnessGoals) || fitnessGoals.some((goal) => !VALID_FITNESS_GOALS.includes(goal))) {
        return res.status(400).json({ error: `Invalid fitnessGoals. Must be an array of: ${VALID_FITNESS_GOALS.join(', ')}` });
      }
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (profileImageUrl !== undefined) updates.profileImageUrl = profileImageUrl;
    if (fcmToken !== undefined) updates.fcmToken = fcmToken;
    if (gender !== undefined) updates.gender = gender;
    if (dateOfBirth !== undefined) updates.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
    if (fitnessGoals !== undefined) updates.fitnessGoals = fitnessGoals || [];
    const user = await prisma.user.update({ where: { id: targetUserId }, data: updates });
    res.json({ data: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
