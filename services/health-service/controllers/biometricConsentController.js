import * as biometricConsentService from '../services/biometricConsentService.js';
import { recordAudit } from '../services/auditService.js';

function fail(res, err) {
  res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
}

// Readable without having consented - there is no other way to ask.
export const getConsent = async (req, res) => {
  try {
    res.json({ data: await biometricConsentService.getBiometricConsentService(req.userId) });
  } catch (err) {
    fail(res, err);
  }
};

// Ignores any policyVersion in the body; the server stamps its own. Audited
// for the same reason the device consent is: this row is the legal basis for
// holding the numbers, so "when, and under which wording" has to be answerable.
export const grantConsent = async (req, res) => {
  try {
    const status = await biometricConsentService.grantBiometricConsentService(req.userId);
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
    res.status(201).json({ data: status });
  } catch (err) {
    fail(res, err);
  }
};

// Withdrawal is the half of a consent record most likely to be disputed later,
// so it is logged as deliberately as the grant.
export const revokeConsent = async (req, res) => {
  try {
    const status = await biometricConsentService.revokeBiometricConsentService(req.userId);
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
    res.json({ data: status });
  } catch (err) {
    fail(res, err);
  }
};
