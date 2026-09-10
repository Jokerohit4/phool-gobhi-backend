import * as consentService from '../services/consentService.js';
import { recordAudit } from '../services/auditService.js';

export const grantConsent = async (req, res) => {
  try {
    const consent = await consentService.grantConsentService(req.userId, req.body || {});
    // Audited as a write because this row IS the legal basis for holding any
    // of it. Routine data writes are not logged — a biometric entry carries
    // its own timestamp and the user made it themselves — but "when did this
    // person consent, and under which policy version" is the question an
    // audit trail exists to answer.
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
    res.status(201).json({ data: consent });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const revokeConsent = async (req, res) => {
  try {
    const consent = await consentService.revokeConsentService(req.userId);
    // Withdrawal is the half of the consent record most likely to be
    // disputed later, so it is logged as deliberately as the grant.
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
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

// Internal twin of deleteAllMyData, called by auth-service when the whole
// account is being deleted. Same service call, different caller identity —
// the user is authenticated to auth-service, not to this one.
export const eraseUserInternal = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A numeric userId is required' });
    }
    await consentService.deleteAllDataService(userId);
    // Written AFTER the delete, and deliberately not swept away with it:
    // the audit row is how an erasure can later be evidenced, so erasing
    // it alongside the data would destroy the proof.
    recordAudit({ userId, actorId: null, action: 'delete', dataType: 'all' });
    res.json({ data: { erased: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Deliberately not flag-gated at the route level (see routes/health.js) —
// a user must always be able to delete their own data.
export const deleteAllMyData = async (req, res) => {
  try {
    await consentService.deleteAllDataService(req.userId);
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'delete', dataType: 'all' });
    res.json({ data: { deleted: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
