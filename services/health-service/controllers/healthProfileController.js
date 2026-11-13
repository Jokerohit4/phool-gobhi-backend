import * as service from '../services/healthProfileService.js';
import * as consentService from '../services/healthProfileConsentService.js';
import { recordAudit } from '../services/auditService.js';
import { grantBiometricConsentService } from '../services/biometricConsentService.js';

function fail(res, err) {
  res.status(err.status || 500).json({
    error: err.error || err.message || 'Server error',
    ...(err.code ? { code: err.code } : {}),
  });
}

// Audit dataType 'health_profile' — a separate bucket from 'personalisation'
// so "who read this person's substance answers, and when" is one query.
const audit = (req, action) =>
  recordAudit({ userId: req.userId, actorId: req.userId, action, dataType: 'health_profile' });

export const getProfile = async (req, res) => {
  try {
    const data = await service.getProfileService(req.userId);
    audit(req, 'read');
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const updateProfile = async (req, res) => {
  try {
    const data = await service.updateProfileService(req.userId, req.body || {});
    audit(req, 'write');
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const deleteProfile = async (req, res) => {
  try {
    const data = await service.deleteProfileService(req.userId);
    audit(req, 'delete');
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const getConsent = async (req, res) => {
  try {
    res.json({ data: await consentService.getHealthProfileConsentService(req.userId) });
  } catch (err) {
    fail(res, err);
  }
};

// `bodyNumbers: true` also records body-numbers consent, because the signup
// step asks for weight and height on the same screen and the prompt there
// names both. Two rows, one tap — each still revocable on its own. This route
// is the only way to grant body-numbers consent while healthMetrics is off
// (the /biometrics/consent route sits behind it), which is exactly the
// signup case.
export const grantConsent = async (req, res) => {
  try {
    const data = await consentService.grantHealthProfileConsentService(req.userId);
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
    if (req.body?.bodyNumbers === true) {
      data.bodyNumbers = await grantBiometricConsentService(req.userId);
      recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
    }
    res.status(201).json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const revokeConsent = async (req, res) => {
  try {
    const data = await consentService.revokeHealthProfileConsentService(req.userId);
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const listMedications = async (req, res) => {
  try {
    res.json({ data: await service.listMedicationsService(req.userId) });
  } catch (err) {
    fail(res, err);
  }
};

export const createMedication = async (req, res) => {
  try {
    const data = await service.createMedicationService(req.userId, req.body || {});
    audit(req, 'write');
    res.status(201).json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const updateMedication = async (req, res) => {
  try {
    const data = await service.updateMedicationService(req.userId, parseInt(req.params.id, 10), req.body || {});
    audit(req, 'write');
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const deleteMedication = async (req, res) => {
  try {
    const data = await service.deleteMedicationService(req.userId, parseInt(req.params.id, 10));
    audit(req, 'delete');
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};
