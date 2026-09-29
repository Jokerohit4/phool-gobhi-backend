import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Fitness+ FR-12 + Health+ FR-01, one implementation. Fitness+ only surfaces
// weight/body_fat (the "Track body" 2-tap flow); Health+ Phase 1 adds the
// rest on the same table and endpoints.
//
// The canonical unit per metric lives here rather than being trusted from the
// client — a client sending sleep in hours while another sends minutes would
// quietly corrupt the series. Callers may omit the unit entirely; they may
// not invent one.
export const METRIC_UNITS = {
  weight: 'kg',
  body_fat: 'percent',
  resting_hr: 'bpm',
  sleep_minutes: 'minutes',
  steps: 'count',
  hrv: 'ms',
  stress: 'score',
};

// Sanity bounds, not medical judgement — these reject typos and unit
// mix-ups (a weight in pounds, body fat entered as 0.18, sleep in hours)
// before they poison a chart axis. Never a comment on the value itself.
export const METRIC_BOUNDS = {
  weight: [20, 400],
  body_fat: [2, 70],
  resting_hr: [25, 220],
  sleep_minutes: [0, 1440],
  steps: [0, 100000],
  hrv: [1, 400],
  stress: [0, 100],
};

// Metrics that only ever arrive MEASURED (HealthKit / Health Connect, via the
// daily-activity sync), never typed. Steps is the one addressed today: the
// device count is the single source of truth, so a hand-entered value from any
// source would corrupt the very series it feeds. Writes are rejected outright —
// regardless of `source` — keeping one home per metric (biometricEntry for
// things a person can type, DailyActivityMetric for the device copy).
export const MEASURED_ONLY_METRICS = ['steps'];

function localDateIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// A "YYYY-MM-DD" string that is also a real calendar date, in the user's own
// timezone.
//
// The regex alone is not enough, and this is worth spelling out because the
// obvious guard looks airtight: /^\d{4}-\d{2}-\d{2}$/ accepts 2026-02-31,
// 2026-13-45 and 2026-00-00, because it checks the shape of the string and
// nothing about the calendar. What makes that more than cosmetic is the
// upsert key. A row is one-per-(user, metric, day), and these strings sort
// lexically, so 2026-02-31 lands between 2026-02-28 and 2026-03-01 and quietly
// becomes its own point on a chart. Worse, `new Date('2026-02-31')` does not
// fail — JavaScript rolls it over to 2 March — so any code that later parses
// the stored string gets a different day than the one that was written.
//
// Future dates are rejected for the same reason targetService already ignores
// them on read: a body has not been weighed yet, so the row is a clock skew or
// a typo. Accepting one makes the series' most recent point a fiction.
// `allowFuture` exists for the two fields that are genuinely about the future:
// a health-goal target date, and a planned start date. Everything measured —
// weight, and every other biometric — cannot be dated ahead of today, because a
// reading that has not happened is not a reading. The option is additive and
// defaults to the original behaviour, so no existing caller changes meaning.
export function validateLocalDate(value, { today = localDateIST(new Date()), allowFuture = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'localDate must be YYYY-MM-DD';
  }

  // Calendar reality, via Date. Constructing with the explicit T00:00:00Z and
  // reading it back is what catches the roll-over: '2026-02-31' comes back as
  // '2026-03-03', which is not what we were given.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return `localDate ${value} is not a real calendar date`;
  }

  if (!allowFuture && value > today) {
    return `localDate cannot be in the future (today is ${today} in your timezone)`;
  }
  return null;
}

export function validateMetricValue(metric, value) {
  const bounds = METRIC_BOUNDS[metric];
  if (!bounds) return `Unknown metric: ${metric}`;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${metric} must be a number`;
  const [min, max] = bounds;
  if (n < min || n > max) return `${metric} must be between ${min} and ${max} ${METRIC_UNITS[metric]}`;
  return null;
}

// Upsert per (user, metric, day): re-entering today's weight corrects today
// rather than stacking a second row. `source` is carried so a later wearable
// sync overwrites the same row and the series stays one-row-per-day.
export async function upsertEntryService(userId, { metric, value, localDate, source = 'manual', unit: rawUnit }, opts = {}) {
  if (MEASURED_ONLY_METRICS.includes(metric)) {
    const err = new Error(
      `${metric} is measured automatically by your phone or watch and cannot be entered by hand — it syncs via daily activity`);
    err.status = 400;
    throw err;
  }
  const day = localDate || localDateIST(new Date());
  // Re-checked here, not only in the controller, because this is the function
  // every other write path goes through — the daily-activity sync and the
  // tests included. A guard that lives only at the edge is a guard that the
  // next caller forgets.
  const dateProblem = validateLocalDate(day, opts);
  if (dateProblem) {
    const err = new Error(dateProblem);
    err.status = 400;
    throw err;
  }
  const unitProblem = validateUnit(metric, rawUnit);
  if (unitProblem) {
    const err = new Error(unitProblem);
    err.status = 400;
    throw err;
  }
  const unit = METRIC_UNITS[metric];
  return prisma.biometricEntry.upsert({
    where: { userId_metric_localDate: { userId, metric, localDate: day } },
    create: { userId, metric, value, unit, source, localDate: day },
    update: { value, unit, source },
  });
}

// Several metrics in one call — the Health+ "Add today's numbers" quick-add
// form submits weight + sleep + resting HR together, and doing that as one
// round trip keeps that flow under the <60s bar the PRD sets for it.
//
// Every entry is validated before the first write, rather than each being
// written as it is checked. Writing-then-validating means a bad entry at
// position two leaves the first one committed, and for a metric that decides a
// calorie target half a quick-add is worse than none: the user is shown an
// error and will reasonably assume nothing was saved.
export async function upsertManyService(userId, entries, { localDate, source = 'manual' } = {}) {
  const rows = entries.map((entry) => ({
    metric: entry.metric,
    value: entry.value,
    localDate: entry.localDate ?? localDate,
    source: entry.source ?? source,
    unit: entry.unit,
  }));

  for (const row of rows) {
    // Same three checks upsertEntryService makes, run for every row before any
    // row is written. Missing the date check here is not a detail — it is the
    // one that lets entry one through when entry two is bad.
    const dateProblem = validateLocalDate(row.localDate || localDateIST(new Date()));
    if (dateProblem) {
      const err = new Error(dateProblem);
      err.status = 400;
      throw err;
    }
    const valueProblem = validateMetricValue(row.metric, row.value);
    if (valueProblem) {
      const err = new Error(valueProblem);
      err.status = 400;
      throw err;
    }
    const unitProblem = validateUnit(row.metric, row.unit);
    if (unitProblem) {
      const err = new Error(unitProblem);
      err.status = 400;
      throw err;
    }
    if (MEASURED_ONLY_METRICS.includes(row.metric)) {
      const err = new Error(
        `${row.metric} is measured automatically by your phone or watch and cannot be entered by hand — it syncs via daily activity`);
      err.status = 400;
      throw err;
    }
  }

  const saved = [];
  for (const row of rows) {
    saved.push(await upsertEntryService(userId, row));
  }
  return saved;
}

// A unit the client sent, when it sent one that is not the canonical unit for
// this metric.
//
// This exists because "we store kg" is not the same claim as "we received kg",
// and only the second one is true. The service overwrites `unit` with the
// canonical value on every write, so a client posting {value: 150, unit: 'lb'}
// used to get a clean 201 and a stored 150 kg — a 68 kg person's weight
// silently doubled, in a row that reads back as authoritative and is then used
// to compute a calorie target. 3396 kcal instead of 2125, from a typo nobody
// could see.
//
// So the mismatch is rejected rather than corrected. Guessing which unit the
// user meant is the service making a medical-adjacent decision from a typo; a
// 400 costs one retry and says exactly what went wrong.
//
// Omitting `unit` stays allowed — the canonical unit is not a secret, and
// plenty of clients just send the number.
export function validateUnit(metric, unit) {
  if (unit === undefined || unit === null || unit === '') return null;
  if (!METRIC_UNITS[metric]) return `Unknown metric: ${metric}`;
  const canonical = METRIC_UNITS[metric];
  if (unit === canonical) return null;
  return `${metric} must be recorded in ${canonical}, not ${unit}`;
}

// Oldest-first: every consumer is a time series (the G10 chart, the history
// list), and a chart wants chronological points rather than reversing them
// client-side.
export async function listEntriesService(userId, { metric, metrics, from, to } = {}) {
  const wanted = metrics ?? (metric ? [metric] : undefined);
  return prisma.biometricEntry.findMany({
    where: {
      userId,
      ...(wanted ? { metric: { in: wanted } } : {}),
      ...(from || to
        ? { localDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    orderBy: [{ localDate: 'asc' }, { metric: 'asc' }],
  });
}

// Latest value per metric — what a dashboard header wants ("74.2 kg, 18%,
// 52 bpm") without pulling the whole history down to find the last point.
export async function latestByMetricService(userId) {
  const rows = await prisma.biometricEntry.findMany({
    where: { userId },
    orderBy: { localDate: 'desc' },
  });
  const latest = {};
  for (const row of rows) {
    if (!latest[row.metric]) latest[row.metric] = row;
  }
  return latest;
}

export async function deleteEntryService(userId, metric, localDate) {
  const existing = await prisma.biometricEntry.findUnique({
    where: { userId_metric_localDate: { userId, metric, localDate } },
  });
  if (!existing || existing.userId !== userId) {
    const err = new Error('Entry not found');
    err.status = 404;
    throw err;
  }
  await prisma.biometricEntry.delete({ where: { id: existing.id } });
}
