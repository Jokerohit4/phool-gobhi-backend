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
      return res.status(status).json({
        error: err.error || err.message || 'Server error',
        code: err.code,
        // A version mismatch is only actionable if the app learns which version
        // it needs. Without this the 409 is a dead end: the user is told the
        // copy changed and given no way to get the new copy.
        ...(err.currentVersion ? { currentVersion: err.currentVersion } : {}),
      });
    }
  };
}

// The current policy version, served alongside the state. The app needs it to
// render the prompt and to send the matching version back on grant, so it
// cannot be a value the app hardcodes and hopes stays in step — that
// arrangement is what let a stale app record consent to wording that was never
// on its screen. One server-owned value, read by everyone.
export const getPolicy = handle(async () => ({
  version: ledgerConsent.CURRENT_LEDGER_POLICY_VERSION,
}));

export const getConsent = handle(async (req) => ({
  version: ledgerConsent.CURRENT_LEDGER_POLICY_VERSION,
  nutrition: await ledgerConsent.getNutritionConsentService(req.userId),
  medicalRecords: await ledgerConsent.getMedicalRecordsConsentService(req.userId),
  photo: await ledgerConsent.getPhotoConsentService(req.userId),
}));

export const grantNutrition = handle(async (req) => {
  const out = await ledgerConsent.grantNutritionConsentService(req.userId, {
    // The client sends the version it displayed, so a stale app showing an old
    // copy cannot record consent to wording the person never saw. The service
    // rejects a mismatch with a 409 — it did not used to, despite this comment
    // saying so, and the version was never persisted at all.
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

export const grantPhoto = handle(async (req) => {
  const out = await ledgerConsent.grantPhotoConsentService(req.userId, {
    privacyVersion: req.body?.privacyVersion,
  });
  track('health_photo_consent_granted', req.userId, {
    version: req.body?.privacyVersion || null,
  });
  return out;
});

export const revokePhoto = handle(async (req) => {
  // Purge opt-in, for the same reason as the other two. "Stop sending my
  // photos" is not "delete every photo I already sent", and for a meal someone
  // photographed as a record of an evening out the difference matters.
  const purge = req.body?.deleteExisting === true;
  const out = await ledgerConsent.revokePhotoConsentService(req.userId, { purge });
  track('health_photo_consent_revoked', req.userId, { purged: purge });
  return out;
});
