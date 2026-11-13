import { hasLocationRoutesConsentService } from '../services/locationRoutesService.js';

/// Gates the routes that read or write recorded GPS route data.
///
/// Separate from the feature flag above it: the flag answers "does this exist",
/// this answers "has this person agreed to it". A 403 with CONSENT_REQUIRED is
/// something the UI can turn into an explainer + opt-in prompt; a
/// FEATURE_DISABLED is not.
///
/// Deliberately distinct from requireCycleConsent: cycle data and run routes
/// are different classes of sensitive data and get separate, separately
/// withdrawable scopes. Revoking one must not silently revoke the other.
export async function requireLocationRoutesConsent(req, res, next) {
  try {
    if (await hasLocationRoutesConsentService(req.userId)) return next();
    return res.status(403).json({
      error: 'Run routes are off for your account.',
      code: 'ROUTE_CONSENT_REQUIRED',
    });
  } catch (err) {
    // Fails CLOSED. A route is a precise location history and most runs start
    // and end at home, so a lookup failure must not become an open door.
    return res.status(503).json({
      error: 'Could not verify your run-route consent. Please try again.',
      code: 'ROUTE_CONSENT_CHECK_FAILED',
    });
  }
}
