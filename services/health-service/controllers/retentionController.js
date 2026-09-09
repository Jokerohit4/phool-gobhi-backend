import * as retentionService from '../services/retentionService.js';

export const getRetentionPolicy = async (req, res) => {
  try {
    const policy = await retentionService.loadRetentionPolicy();
    res.json({ data: policy });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateRetentionPolicy = async (req, res) => {
  try {
    const policy = await retentionService.updateRetentionPolicy(req.body || {}, req.userId);
    res.json({ data: policy });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Called by a scheduled workflow, the same pattern as the Razorpay reconcile
// sweep. Idempotent — it deletes by age, so a re-run finds nothing.
export const runRetentionSweepInternal = async (req, res) => {
  try {
    const result = await retentionService.runRetentionSweepService();
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
