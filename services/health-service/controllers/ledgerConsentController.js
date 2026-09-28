import * as ledgerConsent from '../services/ledger/ledgerConsentService.js';
import { track } from '../utils/analytics.js';

// Thin adapter over ledgerConsentService, same shape as ledgerController.
//
// The consent routes are the only ledger routes NOT behind a consent gate, so
// this is where the wording of what someone is agreeing to actually matters. It
// is served from the service, not hardcoded here, so the string shown on the
// consent screen and the version recorded against the grant are the same
// version - a mismatch there is how you end up with a privacyVersion that does
// not describe the text the person read.

function handle(fn) {
  return async (req, res) => {
    try {
      return res.json({ data: await fn(req) });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[ledger-consent]', err);
      return res
        .status(status)
        .json({ error: err.error || err.message || 'Server error', code: err.code });
    }
  };
}

export const getConsent = handle(async (req) => ({
  nutrition: await ledgerConsent.getNutritionConsentService(req.userId),
  medicalRecords: await ledgerConsent.getMedicalRecordsConsentService(req.userId),
}));

export const grantNutrition = handle(async (req) => {
  const out = await ledgerConsent.grantNutritionConsentService(req.userId, {
    // The client sends the version it displayed, so a stale app showing an old
    // copy cannot record consent to wording the person never saw. The service
    // rejects a mismatch.
    privacyVersion: req.body?.privacyVersion,
  });
  track('health_nutrition_consent_granted', req.userId, { version: req.body?.privacyVersion || null });
  return out;
});

export const revokeNutrition = handle(async (req) => {
  // `purge`, not `deleteExisting` - the service's option is named purge, and
  // passing the wrong key meant the flag below had no effect at all.
  //
  // Defaulting to false here is the important part. The service defaults
  // `purge` to TRUE, so a bare DELETE arrived here, lost its
  // `deleteExisting: false` because the key was wrong, and fell through to the
  // service default: every food log, saved meal and target deleted with no
  // confirmation anywhere. Consent withdrawal and data deletion are different
  // requests - a person turning off collection is not always asking to have
  // their history destroyed - so purging has to be something they ask for.
  const purge = req.body?.deleteExisting === true;
  const out = await ledgerConsent.revokeNutritionConsentService(req.userId, { purge });
  track('health_nutrition_consent_revoked', req.userId, { purged: purge });
  return out;
});

export const grantMedicalRecords = handle(async (req) => {
  const out = await ledgerConsent.grantMedicalRecordsConsentService(req.userId, {
    privacyVersion: req.body?.privacyVersion,
  });
  // The scope only, never the document count: how many prescriptions someone
  // has uploaded is not a funnel metric.
  track('health_medical_consent_granted', req.userId, {});
  return out;
});

export const revokeMedicalRecords = handle(async (req) => {
  // Same reasoning as the nutrition revoke: purge is opt-in, not the default.
  // For medical records the distinction matters more - a prescription is
  // something someone may need to show a doctor, and silently destroying it
  // because someone tapped "stop collecting" would be genuinely harmful.
  const purge = req.body?.deleteExisting === true;
  const out = await ledgerConsent.revokeMedicalRecordsConsentService(req.userId, { purge });
  track('health_medical_consent_revoked', req.userId, { purged: purge });
  return out;
});
