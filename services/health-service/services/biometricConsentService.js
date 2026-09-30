import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Consent to store the body numbers a person types in by hand: weight, body
// fat, and the Health+ quick-add metrics (sleep, resting HR, HRV, stress).
//
// Its own row, not a scope on HealthConsent. HealthConsent is the device-access
// grant - it exists to gate the HealthKit / Health Connect prompt and cannot be
// written without a platform - so every scope hung off it inherits "connect a
// device first". Typing "72 kg" into a box has nothing to do with device access,
// and requireDeviceHealthConsent already says so in as many words. Gating manual
// entry on that consent would ask the wrong question; not gating it at all left
// a class of health data with no consent record behind it. This closes the gap
// without either.
//
// Shaped like AssistantConsent rather than like the ledger scopes because the
// version here is stamped by the server, never taken from the client. That is
// what makes re-consent enforceable: bump the constant and every earlier grant
// stops counting, whatever an old build of the app believes it displayed.
export const BIOMETRIC_CONSENT_SCOPE = 'body_numbers';

// The wording of the in-app prompt this version describes. Bump it when the
// prompt starts describing different data (a new metric class, a new
// recipient), not for a typo fix. The app's kBodyNumbersPolicyVersion states the
// same fact for display; this one decides what counts.
export const BIOMETRIC_POLICY_VERSION = 'body-numbers-2026-10-01';

export async function getBiometricConsentService(userId) {
  const row = await prisma.biometricConsent.findUnique({ where: { userId } });
  if (!row) {
    return {
      scope: BIOMETRIC_CONSENT_SCOPE,
      granted: false,
      needsReconsent: false,
      policyVersion: BIOMETRIC_POLICY_VERSION,
    };
  }
  const active = !row.revokedAt;
  return {
    scope: BIOMETRIC_CONSENT_SCOPE,
    granted: active && row.policyVersion === BIOMETRIC_POLICY_VERSION,
    // "You agreed, but the wording changed" is a review prompt, not a first-run
    // one, and the app needs to tell the two apart.
    needsReconsent: active && row.policyVersion !== BIOMETRIC_POLICY_VERSION,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    policyVersion: BIOMETRIC_POLICY_VERSION,
  };
}

/// The gate's question: granted, not withdrawn, and under today's wording.
export async function hasBiometricConsentService(userId) {
  return (await getBiometricConsentService(userId)).granted;
}

/// Takes no version from the caller - it records the server's own.
export async function grantBiometricConsentService(userId) {
  const now = new Date();
  await prisma.biometricConsent.upsert({
    where: { userId },
    update: { grantedAt: now, revokedAt: null, policyVersion: BIOMETRIC_POLICY_VERSION },
    create: { userId, grantedAt: now, policyVersion: BIOMETRIC_POLICY_VERSION },
  });
  return getBiometricConsentService(userId);
}

/// Stops collection. Deliberately does NOT delete the numbers already logged:
/// erasure is its own explicit act (per-entry delete on Track Body, or delete
/// all health data), because quietly wiping someone's weight history on a
/// toggle is not a revoke function's call to make. Idempotent - withdrawing
/// something never granted is not an error the user can do anything about.
export async function revokeBiometricConsentService(userId) {
  const row = await prisma.biometricConsent.findUnique({ where: { userId } });
  if (row && !row.revokedAt) {
    await prisma.biometricConsent.update({
      where: { userId },
      data: { revokedAt: new Date() },
    });
  }
  return getBiometricConsentService(userId);
}
