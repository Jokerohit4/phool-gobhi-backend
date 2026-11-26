import * as consentService from '../services/modelTrainingConsentService.js';
import { recordAudit } from '../services/auditService.js';
import { track } from '../utils/analytics.js';

function handle(fn, successStatus = 200) {
  return async (req, res) => {
    try {
      res.status(successStatus).json({ data: await fn(req) });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.error || err.message || 'Server error',
        ...(err.currentVersion ? { currentVersion: err.currentVersion } : {}),
      });
    }
  };
}

export const getConsent = handle((req) => consentService.getConsent(req.userId));

export const getConsentInternal = handle((req) => {
  const userId = Number(req.params.userId);
  if (!/^\d+$/.test(req.params.userId) || userId < 1 || userId > 2147483647) {
    throw Object.assign(new Error('A positive integer userId is required'), { status: 400 });
  }
  return consentService.getConsent(userId);
});

export const grantConsent = handle(async (req) => {
  const status = await consentService.grantConsent(req.userId, req.body?.policyVersion);
  recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
  track('model_training_consent_granted', req.userId, { version: status.policyVersion });
  return status;
}, 201);

export const revokeConsent = handle(async (req) => {
  const { status, revoked } = await consentService.revokeConsent(req.userId);
  if (revoked) {
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'write', dataType: 'consent' });
    track('model_training_consent_revoked', req.userId, { version: status.policyVersion });
  }
  return status;
});
