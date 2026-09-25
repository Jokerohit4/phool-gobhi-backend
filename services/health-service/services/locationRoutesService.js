import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/// The consent scope that GPS route data lives behind.
///
/// Kept separate from CYCLE_SCOPE on purpose. A recorded run is a precise
/// location history — most runs start and end at home — so it gets its own
/// scope the user can see and withdraw on its own, rather than riding along on
/// an unrelated grant. Both scopes live on the same HealthConsent.scopes array
/// (the schema field was built for exactly this: "gaining an entry when the
/// surface needing it ships"), so revoking health consent revokes this too.
export const LOCATION_ROUTES_SCOPE = 'location_routes';

export async function hasLocationRoutesConsentService(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt) return false;
  return (consent.scopes || []).includes(LOCATION_ROUTES_SCOPE);
}

/// Opt in to route storage. Requires live health consent first: the scope lives
/// on that record, so without it there is nowhere to record the grant.
export async function grantLocationRoutesConsentService(
  userId,
  { privacyVersion } = {},
) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt) {
    throw {
      status: 409,
      error:
        'Health consent is required before run routes can be recorded.',
      code: 'HEALTH_CONSENT_REQUIRED',
    };
  }

  const scopes = new Set(consent.scopes || []);
  scopes.add(LOCATION_ROUTES_SCOPE);

  await prisma.healthConsent.update({
    where: { userId },
    data: { scopes: [...scopes] },
  });

  // The privacy wording the client saw when it asked. Falls back to the
  // standing health policy version so the response always carries something
  // auditable, matching how the cycle service records its grant.
  return getLocationRoutesConsentService(userId, privacyVersion);
}

/// Withdraw the scope. Deliberately does NOT delete already-recorded routes:
/// erasure is its own explicit act (account deletion / per-run delete), because
/// silently destroying someone's run history on a toggle is not this function's
/// call to make.
export async function revokeLocationRoutesConsentService(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (consent) {
    await prisma.healthConsent.update({
      where: { userId },
      data: {
        scopes: (consent.scopes || []).filter(
          (s) => s !== LOCATION_ROUTES_SCOPE,
        ),
      },
    });
  }
  return { granted: false };
}

export async function getLocationRoutesConsentService(
  userId,
  privacyVersion,
) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt) return { granted: false };
  return {
    granted: (consent.scopes || []).includes(LOCATION_ROUTES_SCOPE),
    grantedAt: consent.grantedAt,
    privacyVersion: privacyVersion || consent.policyVersion || null,
  };
}
