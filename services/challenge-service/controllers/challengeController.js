import * as coinLedgerService from '../services/coinLedgerService.js';
import * as streakService from '../services/streakService.js';
import * as coinCatalogService from '../services/coinCatalogService.js';
import * as coinEconomyConfigService from '../services/coinEconomyConfigService.js';

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

// ---- Admin (requireRole('gobhi')) --------------------------------------

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

export const recordAttendanceEventInternal = async (req, res) => {
  try {
    const { userId, bookingId, gymId, attendedAt, source } = req.body || {};
    if (!userId || !bookingId || !gymId || !attendedAt || !source) {
      return res.status(400).json({ error: 'userId, bookingId, gymId, attendedAt and source are required' });
    }
    const result = await streakService.recordAttendanceEvent({ userId, bookingId, gymId, attendedAt, source });
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
