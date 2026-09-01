import * as coinLedgerService from '../services/coinLedgerService.js';
import * as streakService from '../services/streakService.js';
import * as coinCatalogService from '../services/coinCatalogService.js';
import * as coinEconomyConfigService from '../services/coinEconomyConfigService.js';
import * as challengeCatalogService from '../services/challengeCatalogService.js';
import * as challengeEnrollmentService from '../services/challengeEnrollmentService.js';
import * as adminChallengeService from '../services/adminChallengeService.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';
import * as pairedStreakService from '../services/pairedStreakService.js';
import * as workoutCreditService from '../services/workoutCreditService.js';

// The gateway forwards the customer app's location headers unchanged, and
// the app attaches them on every request (they back gym discovery the same
// way). They back the 20km challenge radius — see utils/location.js.
function parseLocation(req) {
  const userLat = parseFloat(req.headers['x-user-lat']);
  const userLng = parseFloat(req.headers['x-user-lng']);
  return {
    userLat: Number.isNaN(userLat) ? null : userLat,
    userLng: Number.isNaN(userLng) ? null : userLng,
  };
}

// ---- Customer-facing (requireAuth + requireFeatureFlag('streaksCoins')) ---

export const getMyStreak = async (req, res) => {
  try {
    const streak = await streakService.getStreakService(req.userId);
    res.json({ data: streak });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMyCoinWallet = async (req, res) => {
  try {
    const [balance, ledger] = await Promise.all([
      coinLedgerService.getCoinBalanceService(req.userId),
      coinLedgerService.getCoinLedgerService(req.userId),
    ]);
    res.json({ data: { ...balance, ledger } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getCoinCatalog = async (req, res) => {
  try {
    const items = await coinCatalogService.listActiveCatalogService();
    res.json({ data: items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getChallenges = async (req, res) => {
  try {
    const challenges = await challengeCatalogService.listActiveChallengesService({ userId: req.userId, ...parseLocation(req) });
    res.json({ data: challenges });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getChallengeDetail = async (req, res) => {
  try {
    const detail = await challengeCatalogService.getChallengeDetailService(req.params.id, { userId: req.userId, ...parseLocation(req) });
    res.json({ data: detail });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const enrollInChallenge = async (req, res) => {
  try {
    const enrollment = await challengeEnrollmentService.enrollService(req.userId, req.params.id, parseLocation(req));
    res.status(201).json({ data: enrollment });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const leaveChallenge = async (req, res) => {
  try {
    const enrollment = await challengeEnrollmentService.leaveChallengeService(req.userId, req.params.id);
    res.json({ data: enrollment });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const optInPairedStreak = async (req, res) => {
  try {
    const { matchId } = req.body || {};
    if (!matchId) return res.status(400).json({ error: 'matchId is required' });
    const pairedStreak = await pairedStreakService.optInService(req.userId, matchId);
    res.status(201).json({ data: pairedStreak });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMyPairedStreaks = async (req, res) => {
  try {
    const pairedStreaks = await pairedStreakService.getMyPairedStreaksService(req.userId);
    res.json({ data: pairedStreaks });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const visitCheckpoint = async (req, res) => {
  try {
    const { code, lat, lng } = req.body || {};
    if (!code || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'code, lat and lng are required' });
    }
    const enrollment = await challengeEnrollmentService.visitCheckpointService(req.userId, req.params.id, { code, lat, lng });
    res.json({ data: enrollment });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error', code: err.code });
  }
};

// ---- Admin (requireRole('gobhi')) --------------------------------------

export const listChallengeDefinitionsAdmin = async (req, res) => {
  try {
    res.json({ data: await adminChallengeService.listChallengeDefinitionsAdminService() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createChallengeDefinitionAdmin = async (req, res) => {
  try {
    res.status(201).json({ data: await adminChallengeService.createChallengeDefinitionAdminService(req.body || {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listChallengesAdmin = async (req, res) => {
  try {
    res.json({ data: await adminChallengeService.listChallengesAdminService() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createChallengeAdmin = async (req, res) => {
  try {
    res.status(201).json({ data: await adminChallengeService.createChallengeAdminService(req.body || {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateChallengeAdmin = async (req, res) => {
  try {
    res.json({ data: await adminChallengeService.updateChallengeAdminService(req.params.id, req.body || {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listCheckpointSpotsAdmin = async (req, res) => {
  try {
    res.json({ data: await adminChallengeService.listCheckpointSpotsAdminService(req.params.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createCheckpointSpotAdmin = async (req, res) => {
  try {
    res.status(201).json({ data: await adminChallengeService.createCheckpointSpotAdminService(req.params.id, req.body || {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listEnrollmentsAdmin = async (req, res) => {
  try {
    res.json({ data: await adminChallengeService.listEnrollmentsAdminService(req.params.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listSponsorsAdmin = async (req, res) => {
  try {
    res.json({ data: await adminChallengeService.listSponsorsAdminService() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createSponsorAdmin = async (req, res) => {
  try {
    res.status(201).json({ data: await adminChallengeService.createSponsorAdminService(req.body || {}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getCoinEconomyConfigAdmin = async (req, res) => {
  try {
    const config = await coinEconomyConfigService.loadEconomyConfig();
    res.json({ data: config });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateCoinEconomyConfigAdmin = async (req, res) => {
  try {
    const updated = await coinEconomyConfigService.updateEconomyConfig(req.body || {}, req.userId);
    res.json({ data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listCoinCatalogAdmin = async (req, res) => {
  try {
    const items = await coinCatalogService.listCatalogAdminService();
    res.json({ data: items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createCoinCatalogItemAdmin = async (req, res) => {
  try {
    const item = await coinCatalogService.createCatalogItemAdminService(req.body || {});
    res.status(201).json({ data: item });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateCoinCatalogItemAdmin = async (req, res) => {
  try {
    const item = await coinCatalogService.updateCatalogItemAdminService(req.params.id, req.body || {});
    res.json({ data: item });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Internal (requireInternal) --------------------------------------

// Drives two independent concerns off one attendance signal — streak/coin
// recording (streaksCoins flag) and off-peak-challenge progress (challenges
// flag). Each is gated on its OWN flag rather than the route as a whole, so
// turning one off doesn't silently also disable the other.
export const recordAttendanceEventInternal = async (req, res) => {
  try {
    const { userId, bookingId, memberAttendanceId, gymId, attendedAt, source, idempotencyKey } = req.body || {};
    if (!userId || !gymId || !attendedAt || !source || !idempotencyKey) {
      return res.status(400).json({ error: 'userId, gymId, attendedAt, source and idempotencyKey are required' });
    }
    if (!bookingId && !memberAttendanceId) {
      return res.status(400).json({ error: 'One of bookingId or memberAttendanceId is required' });
    }
    let result = { alreadyRecorded: true };
    if (await isFeatureEnabled('streaksCoins')) {
      result = await streakService.recordAttendanceEvent({ userId, bookingId, memberAttendanceId, gymId, attendedAt, source, idempotencyKey });
    }
    if (await isFeatureEnabled('challenges')) {
      await challengeEnrollmentService.advanceOffPeakChallengesService(userId, attendedAt);
    }
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const closeWeekInternal = async (req, res) => {
  try {
    // Defaults to closing "last week" so the cron can fire any day after a
    // week ends without needing to compute the exact boundary itself.
    const weekStart = req.body?.weekStart
      ? new Date(req.body.weekStart)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const results = await streakService.closeWeek(weekStart);
    if (await isFeatureEnabled('buddyPairedStreaks')) {
      await pairedStreakService.advancePairedStreaksService(weekStart);
    }
    res.json({ data: results });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const creditCoinsInternal = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { amount, description, idempotencyKey } = req.body || {};
    if (!amount || !description) return res.status(400).json({ error: 'amount and description are required' });
    const balance = await coinLedgerService.creditCoinsService(userId, amount, description, idempotencyKey);
    res.json({ data: balance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const debitCoinsInternal = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { amount, description, idempotencyKey } = req.body || {};
    if (!amount || !description) return res.status(400).json({ error: 'amount and description are required' });
    const balance = await coinLedgerService.debitCoinsService(userId, amount, description, idempotencyKey);
    res.json({ data: balance });
  } catch (err) {
    const insufficient = err.message === 'Insufficient coins';
    res.status(insufficient ? 409 : (err.status || 500)).json({ error: err.error || err.message || 'Server error' });
  }
};

// Called by wallet-service at subscription-purchase time when a customer
// chose a coin discount — debits coins and records the redemption in one
// step (see coinCatalogService for why there's no separate reservation
// phase). A 409 here (insufficient coins) is meant to abort the whole
// purchase in the caller, not be swallowed.
export const redeemCoinCatalogItemInternal = async (req, res) => {
  try {
    const { userId, catalogItemKey, idempotencyKey, metadata } = req.body || {};
    if (!userId || !catalogItemKey) return res.status(400).json({ error: 'userId and catalogItemKey are required' });
    const redemption = await coinCatalogService.redeemCatalogItemService({ userId, catalogItemKey, idempotencyKey, metadata });
    res.json({ data: redemption });
  } catch (err) {
    const insufficient = err.message === 'Insufficient coins';
    res.status(insufficient ? 409 : (err.status || 500)).json({ error: err.error || err.message || 'Server error' });
  }
};

// Called by health-service, fire-and-forget, when a WorkoutSession finishes
// (see health-service's implementation plan, "Gamified layer" section).
// Always 200 — "not verified" and "not credited" are normal outcomes, not
// errors, so a caller that doesn't check the response body still behaves
// correctly (it just never gets told it was rewarded).
export const creditWorkoutInternal = async (req, res) => {
  try {
    const { userId, sessionId, description, idempotencyKey } = req.body || {};
    if (!userId || !sessionId || !idempotencyKey) {
      return res.status(400).json({ error: 'userId, sessionId and idempotencyKey are required' });
    }
    const result = await workoutCreditService.verifyAndCreditWorkout({ userId, sessionId, description, idempotencyKey });
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Called by wallet-service if the subscription purchase failed after coins
// were already debited (e.g. lost the concurrent-duplicate-purchase race) —
// reverses the debit. Not flag-gated: a refund must always be reachable
// even if streaksCoins gets turned off mid-flight, so a debit is never
// permanently stranded.
export const refundCoinRedemptionInternal = async (req, res) => {
  try {
    const { idempotencyKey } = req.body || {};
    const redemption = await coinCatalogService.refundRedemptionService(req.params.redemptionId, idempotencyKey);
    res.json({ data: redemption });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
