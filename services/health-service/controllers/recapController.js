import * as recapService from '../services/recapService.js';

export const getWeeklyRecap = async (req, res) => {
  try {
    const { week } = req.query || {};
    if (week !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return res.status(400).json({ error: 'week must be YYYY-MM-DD' });
    }
    const recap = await recapService.getWeeklyRecapService(req.userId, week);
    res.json({ data: recap });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
