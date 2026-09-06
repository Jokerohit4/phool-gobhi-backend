import { PrismaClient } from '@prisma/client';
import { VALID_GENDERS, VALID_FITNESS_GOALS, VALID_EXPERIENCE_LEVELS, VALID_FREQUENCY_INTENTS } from '../constants/userEnums.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { loadProfileCompletionBonusAmount } from '../services/profileCompletionBonusService.js';

const prisma = new PrismaClient();

const BUDDY_SERVICE_URL = process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();
// Someone at least this old must hold an account — mirrors the client-side
// check (phool-gobhi-website lib/age.ts) so the API rejects under-age DOBs
// even when a crafted request bypasses the UI.
const MIN_AGE_YEARS = 11;

// Latest allowed DOB as a UTC-midnight Date (both sides of the comparison in
// updateProfile parse date-only strings, so no timezone drift).
function minAgeCutoffDate() {
  const now = new Date();
  return new Date(
    `${now.getFullYear() - MIN_AGE_YEARS}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`
  );
}

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

// Internal headers for service-to-service calls (shared secret + Cloud Run
// IAM ID token), shared by the credit and the reconciliation lookup below.
async function internalWalletHeaders() {
  return {
    'x-internal-key': INTERNAL_API_KEY,
    'Content-Type': 'application/json',
    ...(await googleIdTokenHeader(WALLET_SERVICE_URL)),
  };
}

// Confirms a credit under the given idempotency key actually landed, via
// wallet-service's by-key reconciliation endpoint (the same lookup
// booking-service uses to resolve stuck-pending bookings). Returns false on
// any failure — the caller decides whether to retry or surface an error.
async function profileCompletionCreditApplied(userId) {
  const key = profileCompletionBonusKey(userId);
  const res = await fetch(
    `${WALLET_SERVICE_URL}/internal/transactions/by-key/${encodeURIComponent(key)}`,
    { headers: await internalWalletHeaders() }
  );
  if (!res.ok) return false;
  const payload = await res.json();
  const tx = payload?.data;
  return !!tx && tx.type === 'credit';
}

// One-time ₹ wallet credit the moment a profile crosses from incomplete to
// complete. Deliberately NOT fire-and-forget anymore: the customer app
// promises this reward, and a profile must not complete without it landing.
// Two reasons the old version silently lost money:
//   1. fetch() does not throw on HTTP error statuses — a 403 from
//      requireInternal (INTERNAL_API_KEY mismatch) or a 5xx resolved
//      "successfully" and was never even logged.
//   2. Success was assumed from the POST alone, never verified.
// Now: check res.ok, then confirm the transaction via the by-key endpoint,
// retrying once on a transient failure. Throws on final failure so the
// caller can roll the profile back (see updateProfile/uploadProfilePicture),
// which makes "no profile completion without the ₹ bonus" structurally
// guaranteed rather than best-effort. The wallet-service idempotencyKey
// keeps this one-time even across retries/races. amount<=0 (admin-disabled)
// skips crediting entirely.
async function creditProfileCompletionBonus(userId) {
  const amount = await loadProfileCompletionBonusAmount();
  if (amount <= 0) return;

  const body = JSON.stringify({
    amount,
    description: 'Profile completion bonus',
    idempotencyKey: profileCompletionBonusKey(userId),
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${WALLET_SERVICE_URL}/${userId}/credit`, {
        method: 'POST',
        headers: await internalWalletHeaders(),
        body,
      });
      if (!res.ok) {
        throw new Error(`wallet credit rejected: HTTP ${res.status}`);
      }
      if (await profileCompletionCreditApplied(userId)) return;
      throw new Error('credit not confirmed by wallet-service');
    } catch (err) {
      lastError = err;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`profile-completion bonus credit failed: ${lastError.message}`);
}

// 502 so the gateway/app can distinguish "your profile change was rolled
// back, retry" from a generic server error, and the retry re-evaluates the
// incomplete->complete transition (idempotency key keeps it one-time).
function bonusCreditError() {
  const err = new Error('Could not credit your profile-completion bonus. Please try again.');
  err.status = 502;
  return err;
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
    experienceLevel: user.experienceLevel || null,
    weeklyFrequencyIntent: user.weeklyFrequencyIntent || null,
    referralCode: user.referralCode || null,
    linkedGymId: user.linkedGymId || null,
    leaderboardOptIn: user.leaderboardOptIn,
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
      try {
        await creditProfileCompletionBonus(targetUserId);
      } catch (err) {
        // Roll the photo back so the profile stays incomplete until the
        // bonus actually lands — the next upload re-evaluates the
        // transition (wallet-service's idempotencyKey keeps it one-time).
        await prisma.user.update({
          where: { id: targetUserId },
          data: { profileImageUrl: before.profileImageUrl },
        });
        throw bonusCreditError();
      }
    }

    res.status(201).json({ data: formatUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
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
    if (dateOfBirth !== undefined && dateOfBirth !== null && dateOfBirth !== '') {
      const dob = new Date(dateOfBirth);
      if (Number.isNaN(dob.getTime()) || dob.getTime() > minAgeCutoffDate().getTime()) {
        return res.status(400).json({ error: `You must be at least ${MIN_AGE_YEARS} years old` });
      }
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
      try {
        await creditProfileCompletionBonus(targetUserId);
      } catch (err) {
        // Revert every field this request changed so the profile stays
        // incomplete until the bonus actually lands — a retry re-evaluates
        // the transition and credits (wallet-service's idempotencyKey keeps
        // it one-time, so the retry can never pay out twice).
        const rollback = {};
        for (const [key, value] of Object.entries(updates)) {
          rollback[key] = before[key] ?? null;
        }
        await prisma.user.update({ where: { id: targetUserId }, data: rollback });
        throw bonusCreditError();
      }
    }

    res.json({ data: formatUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
