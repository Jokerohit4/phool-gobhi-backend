import prisma from '../db/prisma.js';

const SCOPE = 'model_training';
// Version for the future consent prompt. The prompt wording is pending owner review.
const POLICY_VERSION = 'model-training-2026-11-26';

function statusOf(consent) {
  if (!consent) return { scope: SCOPE, granted: false, policyVersion: POLICY_VERSION };
  return {
    scope: SCOPE,
    granted: !consent.revokedAt && consent.policyVersion === POLICY_VERSION,
    grantedAt: consent.grantedAt,
    revokedAt: consent.revokedAt,
    policyVersion: consent.policyVersion,
  };
}

export async function getConsent(userId) {
  return statusOf(await prisma.modelTrainingConsent.findUnique({ where: { userId } }));
}

export async function grantConsent(userId, policyVersion) {
  if (typeof policyVersion !== 'string' || !policyVersion.trim()) {
    throw Object.assign(new Error('policyVersion is required'), { status: 400 });
  }
  if (policyVersion !== POLICY_VERSION) {
    throw Object.assign(new Error('Consent policy version has changed'), {
      status: 409,
      currentVersion: POLICY_VERSION,
    });
  }
  const grant = { grantedAt: new Date(), revokedAt: null, policyVersion: POLICY_VERSION };
  const consent = await prisma.modelTrainingConsent.upsert({
    where: { userId },
    update: grant,
    create: { userId, ...grant },
  });
  return statusOf(consent);
}

export async function revokeConsent(userId) {
  const [consent] = await prisma.modelTrainingConsent.updateManyAndReturn({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!consent) return { status: await getConsent(userId), revoked: false };
  return { status: statusOf(consent), revoked: true };
}
