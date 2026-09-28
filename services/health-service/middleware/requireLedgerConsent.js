import {
  hasNutritionConsentService,
  hasMedicalRecordsConsentService,
  NUTRITION_SCOPE,
  MEDICAL_RECORDS_SCOPE,
} from '../services/ledger/ledgerConsentService.js';

/// Gates the routes that read or write ledger data behind a specific consent
/// scope. Separate from the feature flag, and for the same reason
/// requireCycleConsent.js is: the flag answers "does this exist", the scope
/// answers "has this person agreed to it". A CONSENT_REQUIRED is something the
/// app can turn into an opt-in prompt; a FEATURE_DISABLED is not.
///
/// Two scopes, two gates, and they are never interchangeable. Nutrition and
/// medical records are consented separately on purpose - see the header of
/// ledgerConsentService.js for why bundling them produces a consent screen
/// people click through without reading.

function check(hasConsent) {
  return async (req, res, next) => {
    try {
      if (await hasConsent(req.userId)) return next();
      return res.status(403).json({
        error: 'This is off for your account.',
        code: 'CONSENT_REQUIRED',
      });
    } catch (err) {
      // Fails CLOSED. A consent lookup that throws must not become an open door
      // to reading someone's food log or prescriptions. 503 rather than 403,
      // because "you have not consented" is a statement about the person, and
      // saying that when the real problem is our database is a lie the app
      // would render as a consent prompt.
      console.error('requireLedgerScope: consent check failed:', err.message);
      return res.status(503).json({
        error: 'Could not verify your consent. Please try again.',
        code: 'CONSENT_CHECK_FAILED',
      });
    }
  };
}

export const requireNutritionConsent = check(hasNutritionConsentService);
export const requireMedicalRecordsConsent = check(hasMedicalRecordsConsentService);

/// GET on the consent status endpoints themselves must NOT be gated by these -
/// you cannot ask someone whether they consented only once they have. The
/// scope names are exported for the controller to echo back, so the client
/// renders the same string it gates on rather than a second copy of it that
/// can drift.
export const LEDGER_SCOPES = {
  [NUTRITION_SCOPE]: requireNutritionConsent,
  [MEDICAL_RECORDS_SCOPE]: requireMedicalRecordsConsent,
};
