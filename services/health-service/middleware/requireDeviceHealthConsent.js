import { getConsentStatusService } from '../services/consentService.js';

/// Gates the route that pushes device-read numbers (HealthKit / Health Connect)
/// into our database.
///
/// Before this existed the server accepted a device sync from anyone who had
/// the healthMetrics flag, and the app decided whether to sync from the OS
/// permission alone. Those are not the same fact. A user can revoke our
/// consent in Health Settings while the OS permission stays granted (the OS
/// grant lives in iOS/Android settings, which we cannot revoke for them), and
/// the app would then keep uploading heart rate every dashboard load — exactly
/// the "consent withdrawn but processing continues" failure the SPDI Rules
/// (and, from 2027, DPDP s.6(4)) forbid. The server is the only place that
/// knows the consent was withdrawn, so the server is where the line is held.
///
/// Manual biometric entry is deliberately NOT behind this gate: HealthConsent is
/// the device-access consent, and a person typing their own weight has not been
/// asked about device access at all. That gap is real and tracked separately —
/// gating it on the wrong consent would be worse than not gating it.
export async function requireDeviceHealthConsent(req, res, next) {
  try {
    const status = await getConsentStatusService(req.userId);
    if (status.granted) return next();
    return res.status(403).json({
      error: 'Health data sync is off for your account.',
      code: 'HEALTH_CONSENT_REQUIRED',
    });
  } catch (err) {
    // Fails CLOSED, same as the cycle and route gates: a lookup failure must
    // not become a window in which a withdrawn consent is ignored. The app's
    // sync is fire-and-forget and re-converges per (user, day), so a refused
    // sync costs nothing but a retry on the next load.
    return res.status(503).json({
      error: 'Could not verify your health-data consent. Please try again.',
      code: 'HEALTH_CONSENT_CHECK_FAILED',
    });
  }
}
