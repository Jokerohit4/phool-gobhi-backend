import * as retentionService from '../services/retentionService.js';

export const getRetentionPolicy = async (req, res) => {
  try {
    const policy = await retentionService.loadRetentionPolicy();
    res.json({ data: policy });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// The same policy, read by the person it applies to rather than by an admin.
// DPDP's notice obligation is to the data principal, so the in-app "what we
// keep and for how long" screen has to read the live row — a hardcoded
// number in the client would quietly start lying the first time an admin
// changes the period on legal advice.
//
// Deliberately narrower than the admin read: `updatedBy` is another user's
// id and `id` is an implementation detail, so neither leaves the service.
export const getMyRetentionPolicy = async (req, res) => {
  try {
    const policy = await retentionService.loadRetentionPolicy();
    res.json({ data: { suggestionFeedbackDays: policy.suggestionFeedbackDays } });
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
