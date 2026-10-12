import * as coachConsent from '../services/coachConsentService.js';
import { track } from '../utils/analytics.js';

// Thin adapter over coachConsentService, same shape as
// ledgerConsentController. The consent routes are the one coach surface that
// must NOT sit behind the consent scope itself — otherwise there is no way to
// opt in — so the version of the wording a person agreed to is served from
// the service, never hardcoded here, for the same reason as the ledger: the
// string on the screen and the version recorded against the grant must be the
// same fact.

function handle(fn) {
  return async (req, res) => {
    try {
      return res.json({ data: await fn(req) });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[coach-consent]', err);
      return res.status(status).json({
        error: err.error || err.message || 'Server error',
        code: err.code,
        // A version mismatch is only actionable if the app learns which
        // version it needs, same as the ledger consent controller.
        ...(err.currentVersion ? { currentVersion: err.currentVersion } : {}),
      });
    }
  };
}

export const getConsent = handle(async (req) => coachConsent.getCoachConsentService(req.userId));

export const grantConsent = handle(async (req) => {
  const out = await coachConsent.grantCoachScopeService(req.userId, req.body?.scope, {
    policyVersion: req.body?.policyVersion,
  });
  // The scope, never anything about the journey it unlocks: which consent a
  // person agreed to is a funnel fact, the content behind it is not.
  track('coach_consent_granted', req.userId, { scope: req.body?.scope || null });
  return out;
});

// 204 with no body, per the contract — which is why this is NOT behind
// handle(): that helper always sends JSON. Deliberately not flag- or
// scope-gated at the route either; a user must always be able to withdraw,
// whatever the flags say (see the route declaration in routes/ledger.js).
export const revokeConsent = async (req, res) => {
  try {
    const out = await coachConsent.revokeCoachScopeService(req.userId, req.params.scope);
    track('coach_consent_revoked', req.userId, { scope: req.params.scope });
    res.status(204).end();
    return out;
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[coach-consent]', err);
    return res.status(status).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
};
