import { isFeatureEnabled } from './requireFeatureFlag.js';

// The coach journey's own feature gate. Same rule as requireFeatureFlag, kept
// as a named middleware so a route declaration reads as the decision it makes
// (`requireCoachJourney` names the flag, the way requirePhotoConsent names
// its scope) and so the journey's routes are greppable as a set.
//
// Deliberately NOT layered on healthMetrics or healthLedger: the journey must
// work for a new user who has none of the old Health+ surfaces on — those
// flags describe the food ledger and the derived score, not the plan the
// coach builds. With coachJourney off, every coach route 403s with the same
// FEATURE_DISABLED shape every other disabled feature in this service uses,
// and the pre-existing routes are untouched (see anyOf for why the either-gated
// ones keep answering exactly as they did).
export const requireCoachJourney = async (req, res, next) => {
  try {
    const enabled = await isFeatureEnabled('coachJourney');
    if (!enabled) {
      return res.status(403).json({ error: 'FEATURE_DISABLED' });
    }
  } catch (err) {
    console.error('requireCoachJourney: feature flag check error:', err.message);
    return res.status(503).json({
      error: 'Could not verify feature flag. Please try again.',
      code: 'FEATURE_CHECK_FAILED',
    });
  }
  next();
};
