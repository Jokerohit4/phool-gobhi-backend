import * as progressService from '../services/progressService.js';

export const getProgressSummary = async (req, res) => {
  try {
    const summary = await progressService.getProgressSummaryService(req.userId, req.query.range);
    res.json({ data: summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMuscleReadiness = async (req, res) => {
  try {
    const readiness = await progressService.getMuscleReadinessService(req.userId);
    res.json({ data: readiness });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
