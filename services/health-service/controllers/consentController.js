import * as consentService from '../services/consentService.js';

export const grantConsent = async (req, res) => {
  try {
    const consent = await consentService.grantConsentService(req.userId, req.body || {});
    res.status(201).json({ data: consent });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const revokeConsent = async (req, res) => {
  try {
    const consent = await consentService.revokeConsentService(req.userId);
    res.json({ data: consent });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getConsentStatus = async (req, res) => {
  try {
    const status = await consentService.getConsentStatusService(req.userId);
    res.json({ data: status });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Deliberately not flag-gated at the route level (see routes/health.js) —
// a user must always be able to delete their own data.
export const deleteAllMyData = async (req, res) => {
  try {
    await consentService.deleteAllDataService(req.userId);
    res.json({ data: { deleted: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
