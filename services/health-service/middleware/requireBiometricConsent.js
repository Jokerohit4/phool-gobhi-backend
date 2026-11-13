import { getBiometricConsentService } from '../services/biometricConsentService.js';
import { getConsentStatusService } from '../services/consentService.js';

const DEVICE_SOURCES = new Set(['healthkit', 'health_connect']);

// The rows a POST /biometrics body would write, in the same two shapes the
// controller accepts. Only "which rows, from which source" is read here -
// validating them stays the controller's job.
function rowsOf(body = {}) {
  if (Array.isArray(body.entries) && body.entries.length > 0) {
    return body.entries.map((e) => ({ source: e?.source ?? body.source }));
  }
  return body.metric !== undefined ? [{ source: body.source }] : [];
}

function isManual(source) {
  return source === undefined || source === null || source === 'manual';
}

// Returns the response it sent, or null when consent is in place.
async function refuseUnlessBodyNumbersConsent(req, res) {
  const status = await getBiometricConsentService(req.userId);
  if (status.granted) return null;
  // Two codes, because "never agreed" is an opt-in prompt and "agreed to older
  // wording" is a review prompt for something the person already turned on.
  return res.status(403).json(
    status.needsReconsent
      ? {
          error: 'The wording for saving your body numbers has changed. Please review it to continue.',
          code: 'BIOMETRIC_CONSENT_OUTDATED',
          currentVersion: status.policyVersion,
        }
      : {
          error: 'Saving body numbers is off for your account.',
          code: 'BIOMETRIC_CONSENT_REQUIRED',
        },
  );
}

/// Gates POST /biometrics.
///
/// A hand-typed row (no source, or source 'manual') needs body-numbers consent.
/// A row claiming a device source needs the device-access consent instead -
/// that is the consent that describes device data, and letting a device-tagged
/// row through this route ungated would be a side door around
/// requireDeviceHealthConsent on /daily-activity/sync. A mixed batch needs
/// both. Nothing here touches reads or deletes: seeing, exporting and removing
/// what you already logged never depends on agreeing to log more.
export async function requireBiometricWriteConsent(req, res, next) {
  try {
    const rows = rowsOf(req.body);
    // An empty body is the controller's 400 to give, not a consent question.
    if (rows.length === 0) return next();

    if (rows.some((r) => isManual(r.source))) {
      const refused = await refuseUnlessBodyNumbersConsent(req, res);
      if (refused) return refused;
    }
    if (rows.some((r) => DEVICE_SOURCES.has(r.source))) {
      const device = await getConsentStatusService(req.userId);
      if (!device.granted) {
        return res.status(403).json({
          error: 'Health data sync is off for your account.',
          code: 'HEALTH_CONSENT_REQUIRED',
        });
      }
    }
    return next();
  } catch (err) {
    // Fails CLOSED, like every other consent gate in this service: "we could
    // not check" must not become "go ahead and store it".
    console.error('requireBiometricWriteConsent: consent check failed:', err.message);
    return res.status(503).json({
      error: 'Could not verify your consent. Please try again.',
      code: 'BIOMETRIC_CONSENT_CHECK_FAILED',
    });
  }
}

/// Gates PUT /ledger/setup, but only when the body carries a weight.
///
/// Intake writes weightKg into the same BiometricEntry series Track Body does,
/// with source 'manual', so it is a typed body number like any other and needs
/// the same consent. The nutrition consent the route already requires describes
/// the food log, not body measurements. A setup save that carries no weight is
/// not a body-numbers write and passes straight through.
export async function requireBiometricConsentForIntakeWeight(req, res, next) {
  try {
    const weight = req.body?.weightKg;
    if (weight === undefined || weight === null || weight === '') return next();
    const refused = await refuseUnlessBodyNumbersConsent(req, res);
    if (refused) return refused;
    return next();
  } catch (err) {
    console.error('requireBiometricConsentForIntakeWeight: consent check failed:', err.message);
    return res.status(503).json({
      error: 'Could not verify your consent. Please try again.',
      code: 'BIOMETRIC_CONSENT_CHECK_FAILED',
    });
  }
}
