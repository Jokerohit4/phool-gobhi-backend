import { hasCycleConsentService } from '../services/cycleTrackingService.js';

/// Gates the routes that read or write actual cycle data.
///
/// Separate from the feature flag above it: the flag answers "does this exist",
/// this answers "has this person agreed to it". A 403 with CONSENT_REQUIRED is
/// something the UI can turn into an opt-in prompt; a FEATURE_DISABLED is not.
export async function requireCycleConsent(req, res, next) {
  try {
    if (await hasCycleConsentService(req.userId)) return next();
    return res.status(403).json({
      error: 'Cycle tracking is off for your account.',
      code: 'CONSENT_REQUIRED',
    });
  } catch (err) {
    // Fails CLOSED. This is the most sensitive data the platform holds; a
    // lookup failure must not become an open door to reading or writing it.
    return res.status(503).json({
      error: 'Could not verify your cycle-tracking consent. Please try again.',
      code: 'CONSENT_CHECK_FAILED',
    });
  }
}
