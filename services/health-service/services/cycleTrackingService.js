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

// When the profile has never filled in an average period length, this is the
// window used to expire the recovery mode. 5 days is not a medical claim — it
// is the same default the training override has always effectively run with,
// now made explicit so the window can be computed on read.
const DEFAULT_PERIOD_DAYS = 5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/// Date helpers. Cycle dates are @db.Date columns, which Prisma returns as
/// UTC-midnight instants; every comparison here is date-only so a 6:30 am read
/// in IST does not spill a period boundary into the previous day.
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function dayFromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysIso(iso, days) {
  return new Date(dayFromIso(iso).getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/// The last day low-impact recovery stays active for: the period start through
/// (start + average period length - 1), inclusive. Recovery "expires after her
/// period" is therefore a window computed from stored dates, not a job that has
/// to run — the moment the window closes, every read sees it expired.
function recoveryWindowEnd(profile) {
  if (!profile?.lastPeriodStartDate) return null;
  const periodDays = profile.averagePeriodLengthDays ?? DEFAULT_PERIOD_DAYS;
  return addDaysIso(isoDay(profile.lastPeriodStartDate), periodDays - 1);
}

function isRecoveryActive(profile) {
  const end = recoveryWindowEnd(profile);
  if (!end) return false;
  const today = todayIso();
  return today >= isoDay(profile.lastPeriodStartDate) && today <= end;
}

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
  const granted = await hasCycleConsentService(userId);

  const base = {
    granted,
    averageCycleLengthDays: profile?.averageCycleLengthDays ?? null,
    averagePeriodLengthDays: profile?.averagePeriodLengthDays ?? null,
    lastPeriodStartDate: profile?.lastPeriodStartDate ? isoDay(profile.lastPeriodStartDate) : null,
  };

  if (!granted) {
    return {
      ...base,
      currentPhase: null,
      recoveryModeActiveUntil: null,
      suggestedProgrammingMode: null,
      prediction: null,
    };
  }

  // Expiry is computed on read, not by a cron. Asking for the profile is the
  // trigger that clears an owned low-impact mode whose window has closed.
  await syncProgrammingModeService(userId);

  const phases = await prisma.cyclePhaseEntry.findMany({
    where: { userId },
    orderBy: { startDate: 'desc' },
  });

  return {
    ...base,
    currentPhase: deriveCurrentPhase(profile, phases),
    recoveryModeActiveUntil: isRecoveryActive(profile) ? recoveryWindowEnd(profile) : null,
    // What the engine WOULD program right now, surfaced so a screen can show
    // it as a suggestion rather than a silent switch (female-user audit P1).
    suggestedProgrammingMode: isRecoveryActive(profile) ? 'low_impact_recovery' : 'neutral',
    prediction: await predictNextPeriodStart(userId, profile),
  };
}

/// The phase that best describes "now", from what she has actually logged.
/// The recovery window IS the menstrual phase for the days it covers; outside
/// it, a phase is current only if today falls inside a logged entry's span.
/// Null otherwise — never a confident guess in place of a logged fact.
function deriveCurrentPhase(profile, phases) {
  if (isRecoveryActive(profile)) return 'menstrual';
  const today = todayIso();
  const covering = phases.find((p) => {
    const start = isoDay(p.startDate);
    const end = p.endDate ? isoDay(p.endDate) : start;
    return today >= start && today <= end;
  });
  return covering ? covering.phase : null;
}

/// The next period's start, only once there is enough reality to anchor it:
/// at least two user-logged periods AND an average cycle length. Multiple
/// confirmed periods stop the model echoing a single logged date back as a
/// prediction, so a one-off log never produces one.
async function predictNextPeriodStart(userId, profile) {
  if (!profile?.lastPeriodStartDate || !profile.averageCycleLengthDays) return null;
  const loggedCycles = await prisma.cyclePhaseEntry.count({
    where: { userId, phase: 'menstrual', source: 'user_logged' },
  });
  if (loggedCycles < 2) return null;
  return {
    nextPeriodStart: addDaysIso(isoDay(profile.lastPeriodStartDate), profile.averageCycleLengthDays),
    isEstimate: true,
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
/// It is a suggestion, not a switch (female-user audit P1). Four rules make
/// that literal:
///
///   1. female_default ("lower-body emphasis") is NEVER written here and never
///      touched — only the user can choose it, so a profile showing it is hers
///      and stays exactly as she left it.
///   2. Outside a running period window this service does nothing it does not
///      own: no scribbling on a mode someone else chose, and no claim on
///      ownership before the first period has even arrived.
///   3. During the window it auto-applies low_impact_recovery ONLY over a
///      default state (no mode, or neutral). A non-neutral mode that is not
///      ours is a choice — an injury, a preference — and stays as it was set.
///   4. A mode it DOES own is programmatic and temporary: low_impact_recovery
///      while the recovery window is open, neutral once the window closes.
///      The window is computed on read, so expiry needs no cron job.
///
/// Mapping the menstrual phase to low_impact_recovery is a scheduling default
/// someone can override, not an assertion about what her body can do — the
/// platform makes no safety claim about any life stage (see the FR-27 rationale).
export async function syncProgrammingModeService(userId) {
  if (!(await hasCycleConsentService(userId))) return null;

  const profile = await prisma.cycleTrackingProfile.findUnique({ where: { userId } });
  if (!profile) return null;

  const existing = await prisma.personalisationProfile.findUnique({ where: { userId } });

  // Rule 1: female_default is user-only. It predates this feature in the enum
  // and this file never writes it, so a profile holding it is unambiguous.
  if (existing?.programmingMode === 'female_default') {
    return existing.programmingMode;
  }

  const weOwnIt = profile.managesProgrammingMode === true;
  const recoveryActive = isRecoveryActive(profile);

  if (!weOwnIt) {
    // Rule 2: nothing running, nothing of ours — stay out of the way entirely.
    if (!recoveryActive) return existing?.programmingMode ?? null;
    // Rule 3: a mode we did not set that is anything other than the default is
    // a user's own choice (injury, preference); the first logged period must
    // not pin it, and our window must not expire it either.
    if (existing?.programmingMode && existing.programmingMode !== 'neutral') {
      return existing.programmingMode;
    }
  }

  const target = recoveryActive ? 'low_impact_recovery' : 'neutral';
  if (existing?.programmingMode === target) return target;

  await prisma.personalisationProfile.upsert({
    where: { userId },
    update: { programmingMode: target },
    create: { userId, injuryZones: [], programmingMode: target },
  });
  if (!weOwnIt) {
    await prisma.cycleTrackingProfile.update({
      where: { userId },
      data: { managesProgrammingMode: true },
    });
  }
  return target;
}

/// The read-side of expiry. progressService consumes programmingMode for the
/// training engine; before trusting a stored low_impact_recovery it calls this
/// so a mode this service set during the last period lapses back to neutral
/// the moment the window closes — no job, no second write path. Modes it does
/// not own, and the recovery override while its window is still open, pass
/// through untouched. Returns the mode the caller should use.
export async function releaseExpiredRecoveryMode(userId, currentMode) {
  if (currentMode !== 'low_impact_recovery') return currentMode;
  const profile = await prisma.cycleTrackingProfile.findUnique({ where: { userId } });
  if (!profile || profile.managesProgrammingMode !== true) return currentMode;
  if (isRecoveryActive(profile)) return currentMode;

  await prisma.personalisationProfile.updateMany({
    where: { userId, programmingMode: 'low_impact_recovery' },
    data: { programmingMode: 'neutral' },
  });
  return 'neutral';
}

/// Explicit deletion of the cycle record, separate from revoking consent.
export async function deleteAllCycleDataService(userId) {
  await prisma.$transaction([
    prisma.cyclePhaseEntry.deleteMany({ where: { userId } }),
    prisma.cycleTrackingProfile.deleteMany({ where: { userId } }),
  ]);
  return { deleted: true };
}
