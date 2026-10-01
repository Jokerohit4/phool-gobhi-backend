import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Consent to hold the sensitive health-profile answers: allergies, drinking,
// smoking, the two substance questions and medications.
//
// Its own row, shaped like BiometricConsent and AssistantConsent, not a scope
// on HealthConsent — that row is the device-access grant and needs a
// platform, and nobody should have to connect Apple Health before they can
// say they're allergic to peanuts. The version is stamped by the server, never
// taken from the client, so bumping the constant re-asks everyone.
//
// What this does NOT gate: "prefer not to say" answers and the non-sensitive
// questions (hometown, who cooks, occupation…). Declining to disclose isn't
// health data, and gating it would mean someone who refuses consent can't
// even finish the step that asked.
export const HEALTH_PROFILE_CONSENT_SCOPE = 'health_profile';

// Bump when the prompt describes different data or a new recipient — e.g. if
// these answers ever went anywhere other than the user's own app and coach.
// The app's kHealthProfilePolicyVersion states the same fact for display.
export const HEALTH_PROFILE_POLICY_VERSION = 'health-profile-2026-10-01';

export async function getHealthProfileConsentService(userId) {
  const row = await prisma.healthProfileConsent.findUnique({ where: { userId } });
  if (!row) {
    return {
      scope: HEALTH_PROFILE_CONSENT_SCOPE,
      granted: false,
      needsReconsent: false,
      policyVersion: HEALTH_PROFILE_POLICY_VERSION,
    };
  }
  const active = !row.revokedAt;
  return {
    scope: HEALTH_PROFILE_CONSENT_SCOPE,
    granted: active && row.policyVersion === HEALTH_PROFILE_POLICY_VERSION,
    needsReconsent: active && row.policyVersion !== HEALTH_PROFILE_POLICY_VERSION,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    policyVersion: HEALTH_PROFILE_POLICY_VERSION,
  };
}

export async function hasHealthProfileConsentService(userId) {
  return (await getHealthProfileConsentService(userId)).granted;
}

export async function grantHealthProfileConsentService(userId) {
  const now = new Date();
  await prisma.healthProfileConsent.upsert({
    where: { userId },
    update: { grantedAt: now, revokedAt: null, policyVersion: HEALTH_PROFILE_POLICY_VERSION },
    create: { userId, grantedAt: now, policyVersion: HEALTH_PROFILE_POLICY_VERSION },
  });
  return getHealthProfileConsentService(userId);
}

/// Stops collection. Does not delete — erasure is its own explicit act
/// (DELETE /health-profile, or account deletion), same rule as every other
/// consent in this service except the ledger scopes.
export async function revokeHealthProfileConsentService(userId) {
  const row = await prisma.healthProfileConsent.findUnique({ where: { userId } });
  if (row && !row.revokedAt) {
    await prisma.healthProfileConsent.update({ where: { userId }, data: { revokedAt: new Date() } });
  }
  return getHealthProfileConsentService(userId);
}
