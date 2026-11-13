import {
  hasCoachScopeService,
  BASIC_SCOPE,
  SUPPLEMENTS_SCOPE,
} from '../services/coachConsentService.js';

// Gates the coach-journey routes behind a coach consent scope. Same shape and
// same reasoning as requireLedgerConsent: the flag answers "does this feature
// exist" (403 FEATURE_DISABLED, an admin decision), this answers "has THIS
// person agreed to it" (403 CONSENT_REQUIRED, which the app turns into the
// opt-in prompt rather than an error screen).
//
// Unlike the ledger gate this does not distinguish "never agreed" from
// "agreed to superseded wording". The coach consent screen ships with the
// journey itself — there is no population who granted an older wording under
// a different feature, so the mismatch state cannot arise for real users, and
// a version-check round trip on every plan read would cost more than the
// confusion it prevents. The version is still recorded at grant time and
// still refuses a mismatched grant (see coachConsentService), which is where
// the wording contract is enforced.
export const requireCoachConsent = (scope) => async (req, res, next) => {
  try {
    if (await hasCoachScopeService(req.userId, scope)) return next();
    return res.status(403).json({
      error: 'This is off for your account.',
      code: 'CONSENT_REQUIRED',
    });
  } catch (err) {
    // Fails CLOSED, same as requireLedgerConsent: "you have not consented" is
    // a statement about the person, and saying it when the real problem is
    // our database is a lie the app would render as a consent prompt.
    console.error('requireCoachConsent: consent check failed:', err.message);
    return res.status(503).json({
      error: 'Could not verify your consent. Please try again.',
      code: 'CONSENT_CHECK_FAILED',
    });
  }
};

// Pre-built for the two scopes that exist, mirroring how requireLedgerConsent
// exports its gates. Callers may also compose: requireCoachConsent('basic').
export const requireBasicCoachConsent = requireCoachConsent(BASIC_SCOPE);
export const requireSupplementsCoachConsent = requireCoachConsent(SUPPLEMENTS_SCOPE);
