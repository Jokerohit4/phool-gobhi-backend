import * as cycleService from '../services/cycleTrackingService.js';

function fail(res, err) {
  res.status(err.status || 500).json({
    error: err.error || err.message || 'Server error',
    code: err.code,
  });
}

export const getProfile = async (req, res) => {
  try {
    res.json({ data: await cycleService.getProfileService(req.userId) });
  } catch (err) { fail(res, err); }
};

export const grantConsent = async (req, res) => {
  try {
    const data = await cycleService.grantCycleConsentService(req.userId, {
      privacyVersion: req.body?.privacyVersion,
    });
    res.json({ data });
  } catch (err) { fail(res, err); }
};

export const revokeConsent = async (req, res) => {
  try {
    res.json({ data: await cycleService.revokeCycleConsentService(req.userId) });
  } catch (err) { fail(res, err); }
};

export const updateProfile = async (req, res) => {
  try {
    res.json({ data: await cycleService.updateProfileService(req.userId, req.body || {}) });
  } catch (err) { fail(res, err); }
};

export const logPhase = async (req, res) => {
  try {
    res.json({ data: await cycleService.logPhaseService(req.userId, req.body || {}) });
  } catch (err) { fail(res, err); }
};

export const listPhases = async (req, res) => {
  try {
    res.json({ data: await cycleService.listPhasesService(req.userId, { limit: req.query.limit }) });
  } catch (err) { fail(res, err); }
};

// Separate from revoking consent on purpose: switching a feature off and
// destroying months of someone's records are different intentions, and
// conflating them would delete data the user only meant to stop adding to.
export const deleteAllData = async (req, res) => {
  try {
    res.json({ data: await cycleService.deleteAllCycleDataService(req.userId) });
  } catch (err) { fail(res, err); }
};
