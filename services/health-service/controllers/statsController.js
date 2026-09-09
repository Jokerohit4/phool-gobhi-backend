import * as statsService from '../services/statsService.js';

// One response backs the whole Progress screen (KPI strip, weekly bars,
// consistency heatmap, RPE trend, type split) — the client switches range
// and re-requests rather than assembling four endpoints.
export const getStats = async (req, res) => {
  try {
    const stats = await statsService.getStatsService(req.userId, req.query?.range);
    res.json({ data: stats });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
