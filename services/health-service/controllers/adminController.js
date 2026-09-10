import * as adminService from '../services/adminService.js';

export const getAdoptionSummary = async (req, res) => {
  try {
    const summary = await adminService.getAdoptionSummaryService();
    res.json({ data: summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
