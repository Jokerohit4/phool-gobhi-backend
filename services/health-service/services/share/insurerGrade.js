// The insurer-grade adherence summary, ig-v1.
//
// This is NOT the ledger score, and it deliberately never reads a
// ScoreDaySnapshot. The ledger score is partly derived from Apple Health /
// Health Connect: once HealthGoal.activityIsMeasured flips, the calorie target
// comes from device-synced active kcal (targetEngine.bandForMeasuredBurn over
// DailyActivityMetric). Apple 5.1.3(i) and Google's Health Connect policy both
// forbid using that data for insurance, and "we only shared a number computed
// from it" is not a distinction either policy makes. So the insurer gets a
// separate, narrower computation whose inputs are closed by construction - see
// docs/ABHA-FHIR-INTEGRATION.md §D.5.
//
// Three rules, each enforced here rather than trusted to the caller:
//
//   1. ALLOWED INPUTS ONLY. Gym visits (WorkoutSession rows carrying a
//      bookingId and the attendance provenance booking-service stamped),
//      manually logged or in-app-GPS activities (ExerciseRecord source manual /
//      gps_tracker), plan-item ticks for workout / habit / rest items, the
//      weekly session goal, and the current pause window. The function takes
//      named arguments and ignores everything else, and it re-filters what it
//      is given - a caller that passes HealthKit rows or DailyActivityMetric
//      gets exactly the output it would have got without them. A test pins
//      that (insurerGrade.test.js, "device data cannot move the score").
//
//   2. EVERY NUMBER CARRIES ITS EVIDENCE. An insurer reading "12 workouts" has
//      to be able to tell twelve gym-scanned visits from twelve taps on a
//      phone. So counts are never summed across evidence levels without the
//      split beside them:
//        verified_qr        gym staff scanned the customer's signed booking QR
//        verified_geofence  customer scanned the gym's poster QR, inside the
//                           geofence, against a real active booking
//        partner_manual     gym staff marked attendance by hand (no scan)
//        manual_override    the partner completed the booking with no
//                           attendance proof at all - reported, never verified
//        unknown_provenance a visit-shaped row we cannot prove: legacy rows
//                           from before provenance existed, or a session the
//                           client attached to a booking itself
//        self_reported      anything the user typed or tapped
//      Only verified_qr + verified_geofence count as "verified". partner_manual
//      is staff-attested but carries no cryptographic proof, so it is shown on
//      its own rather than silently promoted; that is the conservative reading
//      and is listed as a decision in the design doc's follow-ups.
//
//   3. ONE FUNCTION, TWO USES. The on-screen preview and the payload that would
//      be signed for an insurer are the same object, produced here. What the
//      user approves is byte-for-byte what is sent. Signing and sharing are not
//      built yet (ShareGrant / ShareDisclosure, Stage 2); `canonicalize` is the
//      seam - the detached JWS will be computed over exactly its output.
//
// Nutrition is excluded from ig-v1 entirely (targets can be device-derived);
// revisit only once a target can be computed from intake alone.
import { isScheduledFor } from '../ledger/scoreEngine.js';
import { isPausedOn } from '../ledger/scoreService.js';

export const IG_RULES_VERSION = 'ig-v1';
export const MAX_RANGE_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Asia/Kolkata';

// booking-service AttendanceMethod -> evidence level. Anything not in this map,
// including null, is unknown_provenance: a method we have never seen must not
// be guessed into a verified bucket.
const METHOD_EVIDENCE = {
  qr_scan: 'verified_qr',
  qr_geofence_self: 'verified_geofence',
  manual_verify: 'partner_manual',
  manual_override: 'manual_override',
};
const VISIT_LEVELS = ['verified_qr', 'verified_geofence', 'partner_manual', 'manual_override', 'unknown_provenance'];
const VERIFIED_LEVELS = new Set(['verified_qr', 'verified_geofence']);

// Only these ExerciseRecord sources are ours. healthkit / health_connect are the
// device-synced rows the policies above are about.
const ALLOWED_RECORD_SOURCES = new Set(['manual', 'gps_tracker']);
// Plan-item kinds that are behaviour, not nutrition and not medical. Doctor
// items are excluded even though they are ticked the same way: a medication
// tick in an insurer payload is a disclosure of a prescription.
const ALLOWED_PLAN_KINDS = new Set(['workout', 'habit', 'rest']);

// Why each excluded category is excluded. Sent with every payload, so the
// recipient sees what is NOT in it and why, rather than inferring completeness.
export const EXCLUSIONS = [
  { category: 'device_health_data', reason: 'Apple Health / Health Connect data is never used for insurance purposes.' },
  { category: 'nutrition', reason: 'Nutrition targets can depend on device activity data; excluded in ig-v1.' },
  { category: 'biometrics', reason: 'Body measurements are not adherence evidence and are never shared.' },
  { category: 'medical', reason: 'Conditions, prescriptions, doctor plan items and documents are never shared.' },
  { category: 'cycle', reason: 'Cycle data is never shared.' },
  { category: 'ledger_score', reason: 'The personal ledger score is partly device-derived and is not shared.' },
];

export function localDateIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: TZ });
}

function addDays(localDate, n) {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the ISO week containing localDate.
function weekStart(localDate) {
  const d = new Date(`${localDate}T00:00:00Z`);
  return addDays(localDate, -((d.getUTCDay() + 6) % 7));
}

// The instant a local IST day ends, for lag measurement. IST is a fixed +05:30.
function endOfDayIST(localDate) {
  return new Date(`${addDays(localDate, 1)}T00:00:00+05:30`);
}

export function validateRange({ from, to }) {
  for (const [name, v] of [['from', from], ['to', to]]) {
    if (typeof v !== 'string' || !DATE_RE.test(v)) {
      throw { status: 400, error: `${name} must be YYYY-MM-DD`, code: 'INVALID_DATE' };
    }
  }
  if (from > to) throw { status: 400, error: 'from must not be after to', code: 'INVALID_RANGE' };
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw { status: 400, error: `A range may cover at most ${MAX_RANGE_DAYS} days`, code: 'RANGE_TOO_LONG' };
  }
  return days;
}

function emptyLevels() {
  return Object.fromEntries(VISIT_LEVELS.map((l) => [l, 0]));
}

function hoursBetween(a, b) {
  return Math.round(((b - a) / 3600000) * 10) / 10;
}

/**
 * Compute ig-v1 for [from, to] (inclusive local IST days).
 *
 * Pure: no I/O, no clock except the `now` passed in. Named inputs only.
 */
export function computeInsurerGrade({
  from,
  to,
  sessions = [],
  exerciseRecords = [],
  planItems = [],
  completions = [],
  weeklyGoal = null,
  pause = null,
  now,
}) {
  const days = validateRange({ from, to });
  const inRange = (d) => typeof d === 'string' && d >= from && d <= to;
  const today = localDateIST(now);

  // ---- Gym visits --------------------------------------------------------
  // One visit per booking. A visit's day is the gym's attendedAt when we have
  // it (server instant, IST), otherwise the session's localDate. Only sessions
  // that carry a bookingId are visit-shaped at all; a client can attach a
  // bookingId itself, which is exactly why a null method is unknown, not
  // verified.
  const visitsByBooking = new Map();
  for (const s of sessions) {
    if (s?.bookingId == null) continue;
    const day = s.attendedAt ? localDateIST(s.attendedAt) : s.localDate;
    if (!inRange(day)) continue;
    const evidence = METHOD_EVIDENCE[s.attendanceMethod] || 'unknown_provenance';
    const prev = visitsByBooking.get(s.bookingId);
    // Two rows for one booking should not exist (the draft is idempotent on
    // bookingId), but if they do, keep the stronger evidence rather than
    // double-counting the visit.
    if (!prev || VISIT_LEVELS.indexOf(evidence) < VISIT_LEVELS.indexOf(prev.evidence)) {
      visitsByBooking.set(s.bookingId, { day, evidence });
    }
  }
  const visits = [...visitsByBooking.values()];
  const visitLevels = emptyLevels();
  for (const v of visits) visitLevels[v.evidence] += 1;
  const verifiedVisits = visits.filter((v) => VERIFIED_LEVELS.has(v.evidence)).length;

  // ---- Self-reported activities -----------------------------------------
  const records = exerciseRecords.filter(
    (r) => ALLOWED_RECORD_SOURCES.has(r?.source) && r.startedAt && inRange(localDateIST(r.startedAt)),
  );

  // ---- Plan ticks (workout / habit / rest only) --------------------------
  const allowedItems = planItems.filter((i) => ALLOWED_PLAN_KINDS.has(i?.kind));
  const itemById = new Map(allowedItems.map((i) => [i.id, i]));
  const ticks = completions.filter((c) => itemById.has(c?.planItemId) && inRange(c.localDate));
  const ticksByKind = { workout: 0, habit: 0, rest: 0 };
  for (const c of ticks) ticksByKind[itemById.get(c.planItemId).kind] += 1;

  // Planned occurrences, using the engine's own schedule rule so this can
  // never disagree with what the user was shown as due. One exception: the
  // engine treats a 'weekly' item as due every day, which is right for a daily
  // to-do list and wrong for a count of planned occurrences - so a weekly item
  // counts once per ISO week here. Only days up to today can be planned-and-
  // missed; a future day in the range is not yet a miss.
  let plannedTicks = 0;
  const weeklySeen = new Set();
  for (let i = 0; i < days; i += 1) {
    const d = addDays(from, i);
    if (d > today) break;
    if (isPausedOn(pause, d)) continue;
    for (const item of allowedItems) {
      if (!isScheduledFor(item, d)) continue;
      if ((item.schedule || 'daily') === 'weekly') {
        const key = `${item.id}:${weekStart(d)}`;
        if (weeklySeen.has(key)) continue;
        weeklySeen.add(key);
      }
      plannedTicks += 1;
    }
  }

  // ---- Pause -------------------------------------------------------------
  // Only the CURRENT pause window is stored (HealthGoal), so a pause that
  // ended and was replaced is not visible here. Reported as a limitation
  // rather than silently undercounted.
  let pausedDays = 0;
  for (let i = 0; i < days; i += 1) if (isPausedOn(pause, addDays(from, i))) pausedDays += 1;

  // ---- Weeks -------------------------------------------------------------
  const goal = Number.isInteger(weeklyGoal?.sessionsPerWeek) ? weeklyGoal.sessionsPerWeek : null;
  const weeks = new Map();
  for (let i = 0; i < days; i += 1) {
    const ws = weekStart(addDays(from, i));
    if (!weeks.has(ws)) weeks.set(ws, { weekStart: ws, visits: emptyLevels(), selfReportedActivities: 0 });
  }
  for (const v of visits) weeks.get(weekStart(v.day)).visits[v.evidence] += 1;
  for (const r of records) weeks.get(weekStart(localDateIST(r.startedAt))).selfReportedActivities += 1;
  const weekRows = [...weeks.values()].map((w) => {
    const verified = w.visits.verified_qr + w.visits.verified_geofence;
    return {
      ...w,
      verifiedVisits: verified,
      // A week is "met on verified evidence" only on verified visits. The
      // looser reading is reported beside it, labelled, never instead of it.
      metOnVerified: goal != null ? verified >= goal : null,
      metIncludingSelfReported:
        goal != null ? verified + w.visits.partner_manual + w.selfReportedActivities >= goal : null,
    };
  });

  // ---- Late entries ------------------------------------------------------
  // How long after the day ended something was entered. This is the auditor's
  // backfilling signal: a tick created three days after the day it claims is
  // not the same evidence as one created that evening.
  const lags = [];
  for (const c of ticks) if (c.createdAt) lags.push(hoursBetween(endOfDayIST(c.localDate), new Date(c.createdAt)));
  for (const r of records) {
    if (r.source === 'manual' && r.createdAt && r.endedAt) lags.push(hoursBetween(new Date(r.endedAt), new Date(r.createdAt)));
  }
  const late = lags.filter((h) => h > 0);

  return {
    rulesVersion: IG_RULES_VERSION,
    period: { from, to, days, timeZone: TZ },
    gymVisits: {
      total: visits.length,
      verified: verifiedVisits,
      byEvidence: visitLevels,
    },
    selfReported: {
      evidence: 'self_reported',
      activities: records.length,
      planTicks: ticksByKind,
      plannedPlanTicks: plannedTicks,
    },
    weeklyGoal: { sessionsPerWeek: goal, evidence: 'self_reported' },
    weeks: weekRows,
    pausedDays: { count: pausedDays, evidence: 'self_reported', note: 'Current pause window only.' },
    lateEntries: {
      evidence: 'self_reported',
      entries: lags.length,
      late: late.length,
      maxLagHours: late.length ? Math.max(...late) : 0,
    },
    excluded: EXCLUSIONS,
  };
}

/**
 * Deterministic serialisation: object keys sorted at every level, arrays kept
 * in order. The signing seam - Stage 2's detached JWS is computed over exactly
 * this string, and the user's preview shows the hash of it, so "what I saw" and
 * "what was signed" can be compared by anyone holding both.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
