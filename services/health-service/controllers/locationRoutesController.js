import * as locationRoutesService from '../services/locationRoutesService.js';

function fail(res, err) {
  res.status(err.status || 500).json({
    error: err.error || err.message || 'Server error',
    code: err.code,
  });
}

export const getConsent = async (req, res) => {
  try {
    res.json({ data: await locationRoutesService.getLocationRoutesConsentService(req.userId) });
  } catch (err) { fail(res, err); }
};

export const grantConsent = async (req, res) => {
  try {
    const data = await locationRoutesService.grantLocationRoutesConsentService(
      req.userId,
      { privacyVersion: req.body?.privacyVersion },
    );
    res.json({ data });
  } catch (err) { fail(res, err); }
};

export const revokeConsent = async (req, res) => {
  try {
    res.json({ data: await locationRoutesService.revokeLocationRoutesConsentService(req.userId) });
  } catch (err) { fail(res, err); }
};
