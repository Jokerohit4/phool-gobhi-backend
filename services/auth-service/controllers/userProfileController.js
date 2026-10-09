import { PrismaClient } from '@prisma/client';
import { VALID_GENDERS, VALID_FITNESS_GOALS, VALID_FREQUENCY_INTENTS, VALID_TRAINING_LOCATION_PREFS, VALID_FREE_TIME_WINDOWS, VALID_APP_MODES, TRAINING_LOCATION_PREFS } from '../constants/userEnums.js';
import { deriveAppMode } from '../services/appModeService.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { loadProfileCompletionBonusAmount } from '../services/profileCompletionBonusService.js';

const prisma = new PrismaClient();

const BUDDY_SERVICE_URL = process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();
// Someone at least this old must hold an account — mirrors the client-side
// check (phool-gobhi-website lib/age.ts) so the API rejects under-age DOBs
// even when a crafted request bypasses the UI. 18+ because attendance/streak
// tracking is behavioural monitoring, which DPDP s.9(3) forbids for children;
// the customer app's DOB pickers and the privacy policy say 18 too.
const MIN_AGE_YEARS = 18;
const MAX_TRAINING_LOCATION_OTHER_CHARS = 80;

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
    // Onboarding branch. `?? null` rather than `|| null` for
    // currentlyWorksOut specifically: it is a tri-state (true/false/unasked)
    // and `false || null` would collapse "no, I don't work out" — the answer
    // that routes someone into the gym_seeker experience — into "never asked".
    currentlyWorksOut: user.currentlyWorksOut ?? null,
    trainingLocationPref: user.trainingLocationPref || null,
    trainingLocationOther: user.trainingLocationOther || null,
    appMode: user.appMode || null,
    freeTimeWindow: user.freeTimeWindow || null,
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

// GET /users/linked-gym/:gymId — the member-scoped read of the gym this
// customer joined through (User.linkedGymId).
//
// Why this exists instead of GET /api/gyms/:id: the public read is
// marketplace-gated (gymService.getGymById throws 404 when
// !marketplaceEnabled || !isActive || !isApproved), and the linked-member home
// is exactly the screen built for the people those gates exclude — a partner
// running attendance-SaaS only never flips marketplaceEnabled on, so their
// members used to land on "Couldn't load your gym" with check-in, score,
// workouts and everything else on the page unreachable behind it.
//
// This path reads gym-service's /internal/:id, which only 404s when the row
// genuinely does not exist, and it refuses any gym the caller is not linked
// to — so a member can only ever read their own gym, regardless of what the
// public list would let them see.
//
// Status contract the app's home renders off:
//   200 {data: gym}  -> pinned hero + the rest of the page
//   404              -> "no gym to show" (not linked, not yours, or the row is
//                       gone): banner + the rest of the page, not an error
//   502              -> gym-service unreachable: a real failure, so the app
//                       offers a retry instead of silently downgrading to the
//                       banner
export const getLinkedGym = async (req, res) => {
  try {
    const userId = parseInt(req.headers['x-user-id']);
    const gymId = parseInt(req.params.gymId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!Number.isInteger(gymId) || gymId <= 0) {
      return res.status(400).json({ error: 'gymId must be a positive integer' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { linkedGymId: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Scoped to the member: anything they aren't linked to is indistinguishable
    // from a gym that doesn't exist, so the caller can't use this route to
    // read gyms the marketplace would have hidden from them.
    if (user.linkedGymId !== gymId) return res.status(404).json({ error: 'Gym not found' });

    let payload;
    try {
      const headers = {
        'x-internal-key': INTERNAL_API_KEY,
        ...(await googleIdTokenHeader(GYM_SERVICE_URL)),
      };
      const resp = await fetch(`${GYM_SERVICE_URL}/internal/${gymId}`, { headers });
      if (resp.status === 404) return res.status(404).json({ error: 'Gym not found' });
      if (!resp.ok) throw new Error(`gym-service responded ${resp.status}`);
      payload = await resp.json();
    } catch (err) {
      // Not a 404: the client must be able to tell "you have no gym" from
      // "we couldn't reach the gym service", or a transient outage would read
      // as a permanently missing gym.
      console.error('[linked-gym] gym-service lookup failed:', err.message);
      return res.status(502).json({ error: 'Could not load your gym' });
    }

    const gym = payload?.data ?? payload;
    if (!gym || gym.id == null) return res.status(404).json({ error: 'Gym not found' });
    res.json({ data: gym });
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
// PUT /users/:userId/app-mode — the user deliberately switching which
// experience the app leads with ("I want to try a gym" / "not into gyms").
//
// Its own route rather than a field on updateProfile, because this is a
// different kind of act: updateProfile derives appMode from the onboarding
// answers, whereas this is the user overriding that derivation. Keeping them
// apart is what lets every override be logged without also logging every
// incidental profile edit.
export const updateAppMode = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });

    const { appMode, source } = req.body || {};
    if (!VALID_APP_MODES.includes(appMode)) {
      return res.status(400).json({ error: `Invalid appMode. Must be one of: ${VALID_APP_MODES.join(', ')}` });
    }

    const before = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!before) return res.status(404).json({ error: 'User not found' });

    // Switching to the mode you are already in is a no-op, not a log entry —
    // otherwise the switch-frequency signal this log exists to produce gets
    // drowned in duplicates from a double-tapped button.
    if (before.appMode === appMode) {
      return res.json({ data: formatUser(before) });
    }

    const [user] = await prisma.$transaction([
      prisma.user.update({ where: { id: targetUserId }, data: { appMode } }),
      prisma.appModeHistory.create({
        data: {
          userId: targetUserId,
          fromMode: before.appMode,
          toMode: appMode,
          source: typeof source === 'string' && source ? source : 'floating_prompt',
        },
      }),
    ]);

    res.json({ data: formatUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });
    const {
      name, phone, profileImageUrl, fcmToken, email, gender, dateOfBirth, fitnessGoals,
      currentlyWorksOut, trainingLocationPref, trainingLocationOther, freeTimeWindow,
      weeklyFrequencyIntent, linkedGymId,
    } = req.body;

    // appMode is deliberately NOT accepted here. It is derived server-side
    // from the answers below (deriveAppMode) so the branching rule lives in
    // one place; a client that wants to switch mode calls the dedicated
    // PUT /users/:userId/app-mode route instead, which logs the change.
    if (trainingLocationPref !== undefined && trainingLocationPref !== null
        && !VALID_TRAINING_LOCATION_PREFS.includes(trainingLocationPref)) {
      return res.status(400).json({ error: `Invalid trainingLocationPref. Must be one of: ${VALID_TRAINING_LOCATION_PREFS.join(', ')}` });
    }
    if (freeTimeWindow !== undefined && freeTimeWindow !== null
        && !VALID_FREE_TIME_WINDOWS.includes(freeTimeWindow)) {
      return res.status(400).json({ error: `Invalid freeTimeWindow. Must be one of: ${VALID_FREE_TIME_WINDOWS.join(', ')}` });
    }
    // The onboarding "how often" answer. It was always sent by the app and
    // read by health-service (goalService derives the first weekly target
    // from it) but this handler never wrote it, so every user's target fell
    // back to the neutral default. Validated against the same enum the
    // Prisma column uses so a bad value is a 400, not a Prisma 500.
    if (weeklyFrequencyIntent !== undefined && weeklyFrequencyIntent !== null
        && !VALID_FREQUENCY_INTENTS.includes(weeklyFrequencyIntent)) {
      return res.status(400).json({ error: `Invalid weeklyFrequencyIntent. Must be one of: ${VALID_FREQUENCY_INTENTS.join(', ')}` });
    }
    if (currentlyWorksOut !== undefined && currentlyWorksOut !== null
        && typeof currentlyWorksOut !== 'boolean') {
      return res.status(400).json({ error: 'currentlyWorksOut must be a boolean' });
    }
    // Free text behind "Somewhere else". It's read by a human deciding the
    // next enum value, so it only needs to be a phrase — the cap stops it
    // becoming a place to paste paragraphs (or anything we'd rather not hold).
    if (trainingLocationOther !== undefined && trainingLocationOther !== null
        && (typeof trainingLocationOther !== 'string'
          || trainingLocationOther.trim().length > MAX_TRAINING_LOCATION_OTHER_CHARS)) {
      return res.status(400).json({ error: `trainingLocationOther must be text of at most ${MAX_TRAINING_LOCATION_OTHER_CHARS} characters` });
    }

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
    // linkedGymId is the gym-join attribution written when a customer follows
    // a gym's join link (the app PUTs it here, and signup/login backfill it
    // server-side). This handler read it as a field to return but never as one
    // to accept, so the app's call succeeded while the value was silently
    // dropped. Immutable once set - same guard as issueSessionForUser, so a
    // later save or a repeat scan of a different poster can never reassign
    // somebody to another gym.
    if (linkedGymId != null && !before.linkedGymId) {
      const resolved = Number(linkedGymId);
      if (Number.isInteger(resolved) && resolved > 0) {
        updates.linkedGymId = resolved;
      }
    }
    if (currentlyWorksOut !== undefined) updates.currentlyWorksOut = currentlyWorksOut;
    if (trainingLocationPref !== undefined) updates.trainingLocationPref = trainingLocationPref;
    if (trainingLocationOther !== undefined) {
      updates.trainingLocationOther = trainingLocationOther ? trainingLocationOther.trim() : null;
    }
    // The free text only means something next to "other". Kept after the user
    // moves to "home" or "gym", it would describe an answer they no longer
    // hold — and accepted alongside one, it's text nobody asked them for.
    const mergedPref = trainingLocationPref !== undefined ? trainingLocationPref : before.trainingLocationPref;
    if (mergedPref !== TRAINING_LOCATION_PREFS.OTHER
        && (updates.trainingLocationOther || (trainingLocationPref !== undefined && before.trainingLocationOther))) {
      updates.trainingLocationOther = null;
    }
    if (freeTimeWindow !== undefined) updates.freeTimeWindow = freeTimeWindow;
    if (weeklyFrequencyIntent !== undefined) updates.weeklyFrequencyIntent = weeklyFrequencyIntent;

    // Re-derive appMode whenever an input to it actually changes, from the
    // merged (before + updates) view rather than the request alone —
    // onboarding sends these answers across more than one PATCH, and deriving
    // from a partial body would flip mode on the first call and flip it back
    // on the second.
    //
    // "Actually changes", not "was sent": the Profile "How you train" editor
    // resends every answer on each save. Someone who switched mode from the
    // floating chip and then only edited their free time would otherwise have
    // that deliberate override silently undone by a re-derivation from
    // answers they didn't touch.
    const answerChanged =
      (currentlyWorksOut !== undefined && currentlyWorksOut !== before.currentlyWorksOut)
      || (trainingLocationPref !== undefined && trainingLocationPref !== before.trainingLocationPref);
    if (answerChanged) {
      updates.appMode = deriveAppMode({ ...before, ...updates });
    }

    // A derived mode change is logged exactly like a chip override, so the
    // history answers "how did this account end up in this mode" without
    // gaps. The first derivation is 'onboarding' (fromMode null); a later one
    // can only come from the user editing their answers, i.e. 'settings'.
    // Both writes in one transaction: a mode with no history row is the gap
    // this log exists to close.
    const modeChanged = answerChanged && updates.appMode && updates.appMode !== before.appMode;
    const user = modeChanged
      ? (await prisma.$transaction([
        prisma.user.update({ where: { id: targetUserId }, data: updates }),
        prisma.appModeHistory.create({
          data: {
            userId: targetUserId,
            fromMode: before.appMode,
            toMode: updates.appMode,
            source: before.appMode ? 'settings' : 'onboarding',
          },
        }),
      ]))[0]
      : await prisma.user.update({ where: { id: targetUserId }, data: updates });

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
