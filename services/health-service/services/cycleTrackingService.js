import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/// The consent scope this feature lives behind. Added to HealthConsent.scopes
/// rather than given its own consent table — the schema comment on that field
/// anticipates exactly this ("storage and a gate", gaining an entry when the
/// surface needing it ships).
export const CYCLE_SCOPE = 'cycle_tracking';

// Sane bounds. Not medical judgement — a typo guard, in the same spirit as
// BiometricMetric.validate. A 3-day or 200-day "cycle" is a slip, and storing
// it would produce predictions that are worse than none.
const MIN_CYCLE_DAYS = 15;
const MAX_CYCLE_DAYS = 90;
const MIN_PERIOD_DAYS = 1;
const MAX_PERIOD_DAYS = 14;

export async function hasCycleConsentService(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt) return false;
  return (consent.scopes || []).includes(CYCLE_SCOPE);
}

/// Opt in. Adds the scope to the existing HealthConsent rather than creating a
/// parallel consent record, so a user revoking health consent revokes this
/// with it — one withdrawal, not two the user has to find separately.
export async function grantCycleConsentService(userId, { privacyVersion } = {}) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt) {
    throw {
      status: 409,
      error: 'Health consent is required before cycle tracking can be switched on.',
      code: 'HEALTH_CONSENT_REQUIRED',
    };
  }

  const scopes = new Set(consent.scopes || []);
  scopes.add(CYCLE_SCOPE);

  await prisma.$transaction([
    prisma.healthConsent.update({
      where: { userId },
      data: { scopes: [...scopes] },
    }),
    prisma.cycleTrackingProfile.upsert({
      where: { userId },
      update: { consentAt: new Date(), privacyVersion: privacyVersion || null },
      create: { userId, consentAt: new Date(), privacyVersion: privacyVersion || null },
    }),
  ]);

  return getProfileService(userId);
}

/// Opt out. Removes the scope and clears consentAt, but does NOT delete the
/// data — deletion is its own explicit act (deleteAllCycleDataService), because
/// silently destroying months of someone's records when they toggle a switch
/// off is not a decision this function should make for them.
export async function revokeCycleConsentService(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (consent) {
    await prisma.healthConsent.update({
      where: { userId },
      data: { scopes: (consent.scopes || []).filter((s) => s !== CYCLE_SCOPE) },
    });
  }
  await prisma.cycleTrackingProfile.updateMany({
    where: { userId },
    data: { consentAt: null },
  });
  return { granted: false };
}

export async function getProfileService(userId) {
  const profile = await prisma.cycleTrackingProfile.findUnique({ where: { userId } });
  return {
    granted: await hasCycleConsentService(userId),
    averageCycleLengthDays: profile?.averageCycleLengthDays ?? null,
    averagePeriodLengthDays: profile?.averagePeriodLengthDays ?? null,
    lastPeriodStartDate: profile?.lastPeriodStartDate ?? null,
  };
}

export async function updateProfileService(userId, input) {
  const { averageCycleLengthDays, averagePeriodLengthDays, lastPeriodStartDate } = input || {};

  if (averageCycleLengthDays != null) {
    const n = Number(averageCycleLengthDays);
    if (!Number.isInteger(n) || n < MIN_CYCLE_DAYS || n > MAX_CYCLE_DAYS) {
      throw { status: 400, error: `averageCycleLengthDays must be between ${MIN_CYCLE_DAYS} and ${MAX_CYCLE_DAYS}` };
    }
  }
  if (averagePeriodLengthDays != null) {
    const n = Number(averagePeriodLengthDays);
    if (!Number.isInteger(n) || n < MIN_PERIOD_DAYS || n > MAX_PERIOD_DAYS) {
      throw { status: 400, error: `averagePeriodLengthDays must be between ${MIN_PERIOD_DAYS} and ${MAX_PERIOD_DAYS}` };
    }
  }

  const data = {};
  if (averageCycleLengthDays != null) data.averageCycleLengthDays = Number(averageCycleLengthDays);
  if (averagePeriodLengthDays != null) data.averagePeriodLengthDays = Number(averagePeriodLengthDays);
  if (lastPeriodStartDate !== undefined) {
    data.lastPeriodStartDate = lastPeriodStartDate ? new Date(lastPeriodStartDate) : null;
  }

  await prisma.cycleTrackingProfile.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });

  // A change to the cycle picture can change how we should be programming, so
  // the derived mode is recomputed here rather than left to drift.
  await syncProgrammingModeService(userId);
  return getProfileService(userId);
}

export async function logPhaseService(userId, { startDate, endDate, phase }) {
  if (!startDate) throw { status: 400, error: 'startDate is required' };
  const validPhases = ['menstrual', 'follicular', 'ovulation', 'luteal'];
  if (!validPhases.includes(phase)) {
    throw { status: 400, error: `phase must be one of: ${validPhases.join(', ')}` };
  }

  const entry = await prisma.cyclePhaseEntry.create({
    data: {
      userId,
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : null,
      phase,
      // Always user_logged here — predictions are written by the derivation
      // below, never by a request. Keeping the two apart is what stops a
      // prediction being shown back as something she said.
      source: 'user_logged',
    },
  });

  if (phase === 'menstrual') {
    await prisma.cycleTrackingProfile.upsert({
      where: { userId },
      update: { lastPeriodStartDate: new Date(startDate) },
      create: { userId, lastPeriodStartDate: new Date(startDate) },
    });
  }

  await syncProgrammingModeService(userId);
  return entry;
}

export async function listPhasesService(userId, { limit = 60 } = {}) {
  return prisma.cyclePhaseEntry.findMany({
    where: { userId },
    orderBy: { startDate: 'desc' },
    take: Math.min(Math.max(Number(limit) || 60, 1), 200),
  });
}

/// The ONLY bridge from cycle data to anything that affects training.
///
/// This is the containment that makes the override reversible: no suggestion,
/// readiness or template code reads CyclePhaseEntry. They read
/// PersonalisationProfile.programmingMode, exactly as they did before this
/// feature existed. Switch the cycleTracking flag off and every one of them
/// behaves identically to today.
///
/// Deliberately coarse, and deliberately not a claim. Mapping the menstrual
/// phase to low_impact_recovery is a scheduling default someone can override,
/// not an assertion about what her body can do — the platform makes no safety
/// claim about any life stage (see the FR-27 rationale).
export async function syncProgrammingModeService(userId) {
  if (!(await hasCycleConsentService(userId))) return null;

  const profile = await prisma.cycleTrackingProfile.findUnique({ where: { userId } });
  if (!profile) return null;

  const latest = await prisma.cyclePhaseEntry.findFirst({
    where: { userId },
    orderBy: { startDate: 'desc' },
  });

  const mode = latest?.phase === 'menstrual' ? 'low_impact_recovery' : 'female_default';

  const existing = await prisma.personalisationProfile.findUnique({ where: { userId } });

  // Never overwrite a low-impact mode this service did not set — that one was
  // chosen by the user for a reason of their own (typically an injury), and
  // cycle data may raise caution but must not quietly remove it.
  //
  // `managesProgrammingMode` is what makes that distinguishable. Without it
  // the guard cannot tell her choice from our own setting last cycle, and the
  // first logged period would pin her to low-impact forever.
  const weOwnIt = profile.managesProgrammingMode === true;
  if (!weOwnIt && existing?.programmingMode === 'low_impact_recovery') {
    return existing.programmingMode;
  }

  await prisma.personalisationProfile.upsert({
    where: { userId },
    update: { programmingMode: mode },
    create: { userId, injuryZones: [], programmingMode: mode },
  });
  if (!weOwnIt) {
    await prisma.cycleTrackingProfile.update({
      where: { userId },
      data: { managesProgrammingMode: true },
    });
  }
  return mode;
}

/// Explicit deletion of the cycle record, separate from revoking consent.
export async function deleteAllCycleDataService(userId) {
  await prisma.$transaction([
    prisma.cyclePhaseEntry.deleteMany({ where: { userId } }),
    prisma.cycleTrackingProfile.deleteMany({ where: { userId } }),
  ]);
  return { deleted: true };
}
