import * as nudgeService from '../services/nudgeService.js';
import * as unloggedService from '../services/unloggedService.js';

// FR-03's last piece: "you were at the gym and haven't said what you did."
export const getUnlogged = async (req, res) => {
  try {
    const entries = await unloggedService.getUnloggedAttendanceService(req.userId);
    res.json({ data: entries });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getNudgeSettings = async (req, res) => {
  try {
    const optedOut = await nudgeService.getOptOutsService(req.userId);
    res.json({ data: { types: nudgeService.NUDGE_TYPES, optedOut } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateNudgeSettings = async (req, res) => {
  try {
    const { type, optedOut } = req.body || {};
    if (typeof optedOut !== 'boolean') {
      return res.status(400).json({ error: 'optedOut must be a boolean' });
    }
    const result = await nudgeService.setOptOutService(req.userId, type, optedOut);
    res.json({ data: { types: nudgeService.NUDGE_TYPES, optedOut: result } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Run by a scheduled workflow, same pattern as the retention sweep. Safe to
// re-run: the frequency guards make a second run within 24h a no-op.
export const runNudgeSweepInternal = async (req, res) => {
  try {
    const result = await nudgeService.runNudgeSweepService();
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
