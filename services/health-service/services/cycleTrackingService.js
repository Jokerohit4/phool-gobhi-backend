import prisma from '../db/prisma.js';
import { istDateString } from '../utils/sessionDay.js';


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
  return istDateString(new Date());
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
///
/// What it DOES do is hand back the one thing the feature set on the user's
/// behalf: a low_impact_recovery that this service applied. With consent off the
/// sync no longer runs, so nothing else would ever release it, and the user
/// would keep being programmed from a period she has stopped sharing. A mode she
/// chose herself is never touched (see releaseOwnedRecoveryMode).
export async function revokeCycleConsentService(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (consent) {
    await prisma.healthConsent.update({
      where: { userId },
      data: { scopes: (consent.scopes || []).filter((s) => s !== CYCLE_SCOPE) },
    });
  }
  await releaseOwnedRecoveryMode(prisma, userId);
  await prisma.cycleTrackingProfile.updateMany({
    where: { userId },
    data: { consentAt: null, managesProgrammingMode: false },
  });
  return { granted: false };
}

/// Puts PersonalisationProfile.programmingMode back to neutral, but ONLY when the
/// cycle feature is what set it: the profile says it owns the mode and the mode
/// is the one it applies (low_impact_recovery). `female_default` and any mode
/// the user picked are left exactly as they are. `db` is the prisma client or a
/// transaction client, so a caller deleting the profile can do this in the same
/// transaction: the profile is the only record of ownership, and once it is gone
/// nothing could ever release the mode.
async function releaseOwnedRecoveryMode(db, userId) {
  const profile = await db.cycleTrackingProfile.findUnique({ where: { userId } });
  if (!profile || profile.managesProgrammingMode !== true) return false;
  const { count } = await db.personalisationProfile.updateMany({
    where: { userId, programmingMode: 'low_impact_recovery' },
    data: { programmingMode: 'neutral' },
  });
  return count > 0;
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

/// How many logged gaps feed the derived average. Recent cycles say more about
/// the next one than a year-old one does, and capping keeps one very old outlier
/// from dragging the estimate.
const MAX_GAPS_FOR_AVERAGE = 6;

/// Mean length of her recent cycles, from the gaps between user-logged period
/// starts. Null when there are not two periods yet, or when the result falls
/// outside the same typo-guard bounds a typed value must meet (a gap of 200 days
/// is a missed log, not a cycle).
function derivedCycleLength(starts) {
  const days = starts.map(isoDay);
  const gaps = [];
  for (let i = 0; i < days.length - 1 && gaps.length < MAX_GAPS_FOR_AVERAGE; i++) {
    gaps.push(Math.round((dayFromIso(days[i]) - dayFromIso(days[i + 1])) / MS_PER_DAY));
  }
  if (!gaps.length) return null;
  const mean = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  return mean >= MIN_CYCLE_DAYS && mean <= MAX_CYCLE_DAYS ? mean : null;
}

/// The next period's start, only once there is enough reality to anchor it: at
/// least two user-logged periods. Multiple confirmed periods stop the model
/// echoing a single logged date back as a prediction, so a one-off log never
/// produces one.
///
/// The cycle length is the one she set when she set one; otherwise it is learned
/// from her own logged gaps, so logging two periods is enough on its own and she
/// is not asked to type a number she may not know.
async function predictNextPeriodStart(userId, profile) {
  if (!profile?.lastPeriodStartDate) return null;
  const logged = (await prisma.cyclePhaseEntry.findMany({
    where: { userId, phase: 'menstrual', source: 'user_logged' },
    orderBy: { startDate: 'desc' },
  })).filter((e) => e.phase === 'menstrual' && e.source === 'user_logged');
  if (logged.length < 2) return null;

  const cycleDays = profile.averageCycleLengthDays
    ?? derivedCycleLength(logged.map((e) => e.startDate).sort((a, b) => b - a));
  if (!cycleDays) return null;
  return {
    nextPeriodStart: addDaysIso(isoDay(profile.lastPeriodStartDate), cycleDays),
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
    // Normally derived from the logged periods (resyncLastPeriodStart); this is
    // the one way to state it without logging a period, so it gets the same
    // checks a logged start does rather than being stored as given.
    data.lastPeriodStartDate = lastPeriodStartDate
      ? dayFromIso(parsePeriodDay(lastPeriodStartDate, 'lastPeriodStartDate', { notFuture: true }))
      : null;
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
  if (!VALID_PHASES.includes(phase)) {
    throw { status: 400, error: `phase must be one of: ${VALID_PHASES.join(', ')}` };
  }

  const startIso = parsePeriodDay(startDate, 'startDate', { notFuture: true });
  const endIso = endDate ? parsePeriodDay(endDate, 'endDate') : null;
  await assertPeriodSpan(userId, { phase, startIso, endIso });

  const entry = await prisma.cyclePhaseEntry.create({
    data: {
      userId,
      startDate: dayFromIso(startIso),
      endDate: endIso ? dayFromIso(endIso) : null,
      phase,
      // Always user_logged here — predictions are written by the derivation
      // below, never by a request. Keeping the two apart is what stops a
      // prediction being shown back as something she said.
      source: 'user_logged',
    },
  });

  if (phase === 'menstrual') await resyncLastPeriodStart(userId);

  await syncProgrammingModeService(userId);
  return entry;
}

const VALID_PHASES = ['menstrual', 'follicular', 'ovulation', 'luteal'];

/// A calendar day from a request, as YYYY-MM-DD, or a 400. Accepts a plain date
/// or an ISO timestamp (its UTC date, which is what a @db.Date column stores
/// anyway); anything else is a typo, not something to hand to the database and
/// answer with a 500. `notFuture` refuses a day that has not happened yet: these
/// are records of what happened, not plans.
function parsePeriodDay(value, field, { notFuture = false } = {}) {
  const text = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : '';
  const iso = validDayIso(/^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text);
  if (!iso) throw { status: 400, error: `${field} must be a valid date (YYYY-MM-DD)` };
  if (notFuture && iso > todayIso()) {
    throw { status: 400, error: `${field} cannot be in the future`, code: 'DATE_IN_FUTURE' };
  }
  return iso;
}

/// The checks that need the other entries. Menstrual periods only, because that
/// is the phase the recovery window, the prediction and the calendar are built on:
///   - the end is not before the start;
///   - a period is at most MAX_PERIOD_DAYS long (the same ceiling the average is
///     held to; the client treats a longer open span as a forgotten log);
///   - it does not overlap or duplicate another logged period. An open period
///     counts as its start day only, so forgetting to close one never blocks the
///     next; closing it later is checked against the others the same way.
/// `selfId` excludes the entry being edited from its own comparison.
async function assertPeriodSpan(userId, { phase, startIso, endIso, selfId = null }) {
  if (endIso && endIso < startIso) {
    throw { status: 400, error: 'endDate cannot be before startDate', code: 'PERIOD_END_BEFORE_START' };
  }
  if (phase !== 'menstrual') return;

  if (endIso && daysBetween(startIso, endIso) + 1 > MAX_PERIOD_DAYS) {
    throw {
      status: 400,
      error: `A period cannot be longer than ${MAX_PERIOD_DAYS} days.`,
      code: 'PERIOD_TOO_LONG',
    };
  }

  const others = (await prisma.cyclePhaseEntry.findMany({
    where: { userId, phase: 'menstrual', source: 'user_logged' },
  })).filter((e) => e.phase === 'menstrual' && e.source === 'user_logged' && e.id !== selfId);
  const end = endIso ?? startIso;
  const clash = others.find((e) => {
    const s = isoDay(e.startDate);
    const t = e.endDate ? isoDay(e.endDate) : s;
    return startIso <= t && s <= end;
  });
  if (clash) {
    throw {
      status: 409,
      error: 'That overlaps a period you already logged. Edit that one instead.',
      code: 'PERIOD_OVERLAP',
    };
  }
}

function daysBetween(fromIso, toIso) {
  return Math.round((dayFromIso(toIso) - dayFromIso(fromIso)) / MS_PER_DAY);
}

/// lastPeriodStartDate is derived, not independent: it is the start of the most
/// recent user-logged period. Recomputing it after every write means a
/// backdated log cannot drag it backwards and a deleted period cannot leave it
/// pointing at a day that no longer exists. When there is no period left it is
/// cleared, which also switches the recovery window and the prediction off.
async function resyncLastPeriodStart(userId) {
  const latest = await prisma.cyclePhaseEntry.findFirst({
    where: { userId, phase: 'menstrual', source: 'user_logged' },
    orderBy: { startDate: 'desc' },
  });
  await prisma.cycleTrackingProfile.upsert({
    where: { userId },
    update: { lastPeriodStartDate: latest ? latest.startDate : null },
    create: { userId, lastPeriodStartDate: latest ? latest.startDate : null },
  });
}

/// Edit one logged entry: close a period (set its end), fix a mistyped date, or
/// change its phase. `endDate: null` re-opens it. Only keys present in `input`
/// change, so closing a period cannot disturb its start.
export async function updatePhaseService(userId, id, input = {}) {
  const entryId = Number(id);
  const entry = Number.isInteger(entryId)
    ? await prisma.cyclePhaseEntry.findFirst({ where: { id: entryId, userId } })
    : null;
  if (!entry) throw { status: 404, error: 'That entry was not found.' };

  const { startDate, endDate, phase } = input;
  if (phase !== undefined && !VALID_PHASES.includes(phase)) {
    throw { status: 400, error: `phase must be one of: ${VALID_PHASES.join(', ')}` };
  }
  if (startDate !== undefined && !startDate) {
    throw { status: 400, error: 'startDate cannot be empty' };
  }

  const startIso = startDate !== undefined
    ? parsePeriodDay(startDate, 'startDate', { notFuture: true })
    : isoDay(entry.startDate);
  const endIso = endDate !== undefined
    ? (endDate ? parsePeriodDay(endDate, 'endDate') : null)
    : (entry.endDate ? isoDay(entry.endDate) : null);
  const nextPhase = phase !== undefined ? phase : entry.phase;
  // Only when something that affects the span changed, so an entry saved before
  // these checks existed is not locked out of an unrelated edit.
  if (startDate !== undefined || endDate !== undefined || phase !== undefined) {
    await assertPeriodSpan(userId, { phase: nextPhase, startIso, endIso, selfId: entry.id });
  }
  const nextStart = dayFromIso(startIso);
  const nextEnd = endIso ? dayFromIso(endIso) : null;

  const data = {};
  if (startDate !== undefined) data.startDate = nextStart;
  if (endDate !== undefined) data.endDate = nextEnd;
  if (phase !== undefined) data.phase = phase;

  const updated = await prisma.cyclePhaseEntry.update({ where: { id: entry.id }, data });
  await resyncLastPeriodStart(userId);
  await syncProgrammingModeService(userId);
  return updated;
}

/// Remove one entry. Scoped to the caller (`userId` in the lookup) so an id from
/// another account is a 404, never a delete.
export async function deletePhaseService(userId, id) {
  const entryId = Number(id);
  const entry = Number.isInteger(entryId)
    ? await prisma.cyclePhaseEntry.findFirst({ where: { id: entryId, userId } })
    : null;
  if (!entry) throw { status: 404, error: 'That entry was not found.' };

  await prisma.cyclePhaseEntry.delete({ where: { id: entry.id } });
  await resyncLastPeriodStart(userId);
  await syncProgrammingModeService(userId);
  return { deleted: true };
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
///
/// The training mode is released in the same transaction as the profile delete.
/// The profile is the only record that the cycle feature set the mode, so
/// deleting it first (or separately) would strand a mid-period user in
/// low_impact_recovery with nothing left that could ever clear it.
export async function deleteAllCycleDataService(userId) {
  await prisma.$transaction(async (tx) => {
    await releaseOwnedRecoveryMode(tx, userId);
    await tx.cyclePhaseEntry.deleteMany({ where: { userId } });
    await tx.cycleDayLog.deleteMany({ where: { userId } });
    await tx.cycleTrackingProfile.deleteMany({ where: { userId } });
  });
  return { deleted: true };
}

// --- Per-day symptom log ----------------------------------------------------
//
// Fixed vocabularies only. A free-text field on this table would let someone
// type a diagnosis or a name into the most sensitive table we hold, so the
// service refuses anything outside these lists. The lists are wellness
// vocabulary, not clinical codes.
export const FLOW_LEVELS = ['spotting', 'light', 'medium', 'heavy'];
export const SYMPTOMS = [
  'cramps', 'headache', 'bloating', 'fatigue', 'backache',
  'nausea', 'breast_tenderness', 'acne', 'cravings', 'poor_sleep',
];

function validDayIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = dayFromIso(value);
  return Number.isNaN(d.getTime()) || isoDay(d) !== value ? null : value;
}

function shapeDayLog(row) {
  return { date: isoDay(row.date), flow: row.flow ?? null, symptoms: row.symptoms ?? [] };
}

export async function listDayLogsService(userId, { from, to } = {}) {
  const range = {};
  if (from) {
    const f = validDayIso(from);
    if (!f) throw { status: 400, error: 'from must be YYYY-MM-DD' };
    range.gte = dayFromIso(f);
  }
  if (to) {
    const t = validDayIso(to);
    if (!t) throw { status: 400, error: 'to must be YYYY-MM-DD' };
    range.lte = dayFromIso(t);
  }
  const rows = await prisma.cycleDayLog.findMany({
    where: { userId, ...(from || to ? { date: range } : {}) },
    orderBy: { date: 'desc' },
    take: 400,
  });
  return rows.map(shapeDayLog);
}

/// Set one day's log. Only keys present change; a day left with no flow and no
/// symptoms is removed rather than kept as an empty row. Future days are
/// refused: this is a record of what happened.
export async function upsertDayLogService(userId, dateIso, input = {}) {
  const day = validDayIso(dateIso);
  if (!day) throw { status: 400, error: 'date must be YYYY-MM-DD' };
  if (day > todayIso()) throw { status: 400, error: 'A future day cannot be logged.' };

  const { flow, symptoms } = input;
  // Refused rather than ignored: a client that still sends a mood must hear
  // that it was not stored, not lose it silently. Mood has one home - the
  // wellness check-in - and a null (what older builds send unprompted) is fine.
  if (input.mood != null) {
    throw { status: 400, error: 'Mood is saved by the wellness check-in, not the cycle log.' };
  }
  if (flow != null && !FLOW_LEVELS.includes(flow)) {
    throw { status: 400, error: `flow must be one of: ${FLOW_LEVELS.join(', ')}` };
  }
  if (symptoms !== undefined) {
    if (!Array.isArray(symptoms) || symptoms.some((x) => !SYMPTOMS.includes(x))) {
      throw { status: 400, error: `symptoms must be a list drawn from: ${SYMPTOMS.join(', ')}` };
    }
  }

  const date = dayFromIso(day);
  const existing = await prisma.cycleDayLog.findFirst({ where: { userId, date } });
  const next = {
    flow: flow !== undefined ? flow : existing?.flow ?? null,
    symptoms: symptoms !== undefined ? [...new Set(symptoms)] : existing?.symptoms ?? [],
  };

  if (!next.flow && next.symptoms.length === 0) {
    if (existing) await prisma.cycleDayLog.delete({ where: { id: existing.id } });
    return { date: day, flow: null, symptoms: [] };
  }

  const row = existing
    ? await prisma.cycleDayLog.update({ where: { id: existing.id }, data: next })
    : await prisma.cycleDayLog.create({ data: { userId, date, ...next } });
  return shapeDayLog(row);
}

export async function deleteDayLogService(userId, dateIso) {
  const day = validDayIso(dateIso);
  if (!day) throw { status: 400, error: 'date must be YYYY-MM-DD' };
  await prisma.cycleDayLog.deleteMany({ where: { userId, date: dayFromIso(day) } });
  return { deleted: true };
}
