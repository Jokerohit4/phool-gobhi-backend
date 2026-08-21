import * as coinLedgerService from '../services/coinLedgerService.js';
import * as streakService from '../services/streakService.js';

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
