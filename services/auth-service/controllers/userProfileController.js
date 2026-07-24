import { PrismaClient } from '@prisma/client';
import { VALID_GENDERS, VALID_FITNESS_GOALS } from '../constants/userEnums.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const prisma = new PrismaClient();

const BUDDY_SERVICE_URL = process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();
const PROFILE_COMPLETION_BONUS = 20;

// Fire-and-forget: keeps buddy-service's denormalized gender/dateOfBirth/
// fitnessGoals cache from drifting after a profile edit (see
// services/buddy-service/services/buddyService.js#syncProfileFromAuth).
// Buddy-service also lazily re-pulls on profile creation and exposes a
// manual refresh endpoint, so a dropped call here just means a slightly
// stale cache until one of those fallbacks runs — never blocks or fails
// this request.
async function syncBuddyProfile(userId) {
  try {
    const headers = { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(BUDDY_SERVICE_URL)) };
    await fetch(`${BUDDY_SERVICE_URL}/internal/profile-sync/${userId}`, { method: 'POST', headers });
  } catch (err) {
    console.error('[buddy-sync] notify failed:', err.message);
  }
}

// Mirrors the customer app's own completeness check (profile_completion_banner.dart):
// every field the Edit Profile screen exposes must be filled. Phone is
// deliberately excluded — it's fixed at OTP signup, never edited here.
function isProfileComplete(user) {
  return Boolean(
    user.name && user.name.trim().length > 0 &&
    user.gender &&
    user.dateOfBirth &&
    Array.isArray(user.fitnessGoals) && user.fitnessGoals.length > 0 &&
    user.profileImageUrl && user.profileImageUrl.length > 0
  );
}

function profileCompletionBonusKey(userId) {
  return `profile-completion-bonus-${userId}`;
}

// One-time ₹20 wallet credit the moment a profile crosses from incomplete to
// complete. idempotencyKey (see wallet-service's creditWalletService) means
// a later edit — or a retried request — can never pay this out twice, so
// callers don't need their own "already paid" bookkeeping. Best-effort: a
// dropped call here shouldn't fail the profile save that triggered it, same
// tradeoff as syncBuddyProfile above.
async function creditProfileCompletionBonus(userId) {
  try {
    const headers = {
      'x-internal-key': INTERNAL_API_KEY,
      'Content-Type': 'application/json',
      ...(await googleIdTokenHeader(WALLET_SERVICE_URL)),
    };
    await fetch(`${WALLET_SERVICE_URL}/${userId}/credit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: PROFILE_COMPLETION_BONUS,
        description: 'Profile completion bonus',
        idempotencyKey: profileCompletionBonusKey(userId),
      }),
    });
  } catch (err) {
    console.error('[profile-completion-bonus] credit failed:', err.message);
  }
}

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
    const requestingUserId = parseInt(req.headers['x-user-id']);
    if (requestingUserId !== Number(authId)) return res.status(403).json({ error: 'Forbidden' });
    const user = await prisma.user.findUnique({ where: { id: Number(authId) } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.status(201).json({ data: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// GET /users/:userId — unlike the other routes here, this had no ownership
// check at all: any authenticated user could read any other user's full
// profile (name, email, DOB, gender, fitness goals) just by guessing an id.
export const getProfile = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });
    const user = await prisma.user.findUnique({ where: { id: targetUserId } });
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

    const before = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!before) return res.status(404).json({ error: 'User not found' });

    const user = await prisma.user.update({
      where: { id: targetUserId },
      data: { profileImageUrl: req.file.path },
    });

    if (!isProfileComplete(before) && isProfileComplete(user)) {
      creditProfileCompletionBonus(targetUserId);
    }

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

    const before = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!before) return res.status(404).json({ error: 'User not found' });

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

    if (gender !== undefined || dateOfBirth !== undefined || fitnessGoals !== undefined) {
      syncBuddyProfile(targetUserId);
    }

    if (!isProfileComplete(before) && isProfileComplete(user)) {
      creditProfileCompletionBonus(targetUserId);
    }

    res.json({ data: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
