import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const EMPTY_PROFILE = {
  heightCm: null,
  setupWeightKg: null,
  experienceLevel: null,
  injuryZones: [],
  energyPattern: null,
  preferredRestDay: null,
  programmingMode: 'neutral',
  consentAt: null,
  privacyVersion: null,
  trainingLocation: null,
};

// Never 404s on "no profile yet" — a user who has skipped the whole setup is
// in a perfectly valid state (FR-26's P7 principle), and the client needs
// the same shape either way so the Settings rows render without branching.
export async function getProfileService(userId) {
  const profile = await prisma.personalisationProfile.findUnique({ where: { userId } });
  return profile ?? { userId, ...EMPTY_PROFILE };
}

// Partial by design: the setup flow saves Step A (height/weight) and Step B
// (the optional detail) independently, and either can be skipped forever.
// An explicitly-passed null clears a field — that's how "I'd rather not say
// after all" works from the Settings screen, and it's why this checks
// `!== undefined` rather than truthiness.
export async function upsertProfileService(userId, patch) {
  const data = {};
  for (const field of [
    'heightCm', 'setupWeightKg', 'experienceLevel',
    'injuryZones', 'energyPattern', 'preferredRestDay',
  ]) {
    if (patch[field] !== undefined) data[field] = patch[field];
  }
  return prisma.personalisationProfile.upsert({
    where: { userId },
    create: { userId, injuryZones: [], ...data },
    update: data,
  });
}

// FR-25/27's only write path for programming mode. Anything other than
// `neutral` is a personalised mode, so it requires an explicit consent
// version — which records that consent happened, never what was disclosed
// to arrive at the mode (see the ProgrammingMode schema comment).
// Switching back to `neutral` needs no consent: withdrawing is always
// frictionless, and it clears the consent record with it.
export async function setProgrammingModeService(userId, mode, privacyVersion) {
  if (mode !== 'neutral' && !privacyVersion) {
    const err = new Error('privacyVersion is required to enable personalised programming');
    err.status = 400;
    throw err;
  }
  const data = mode === 'neutral'
    ? { programmingMode: 'neutral', consentAt: null, privacyVersion: null }
    : { programmingMode: mode, consentAt: new Date(), privacyVersion };
  return prisma.personalisationProfile.upsert({
    where: { userId },
    create: { userId, injuryZones: [], ...data },
    update: data,
  });
}

export async function deleteProfileService(userId) {
  await prisma.personalisationProfile.deleteMany({ where: { userId } });
}

// H-19. Deliberately its own function, not folded into upsertProfileService's
// generic patch: trainingLocation is reachable via a route gated only on
// healthMetrics (routes/health.js), never on healthPersonalisation, because
// setting it is a UI-routing preference, not a disclosure — unlike
// programmingMode, it never touches consentAt/privacyVersion. Keeping it on
// its own write path is what makes that guarantee structural rather than a
// convention someone could accidentally break by adding it to the shared
// patch allowlist.
export async function updateTrainingLocationService(userId, trainingLocation) {
  return prisma.personalisationProfile.upsert({
    where: { userId },
    create: { userId, injuryZones: [], trainingLocation },
    update: { trainingLocation },
  });
}
