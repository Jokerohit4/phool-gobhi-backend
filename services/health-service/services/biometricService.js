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

function localDateIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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
export async function upsertEntryService(userId, { metric, value, localDate, source = 'manual' }) {
  const day = localDate || localDateIST(new Date());
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
export async function upsertManyService(userId, entries, { localDate, source = 'manual' } = {}) {
  const saved = [];
  for (const entry of entries) {
    saved.push(await upsertEntryService(userId, {
      metric: entry.metric,
      value: entry.value,
      localDate: entry.localDate ?? localDate,
      source: entry.source ?? source,
    }));
  }
  return saved;
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
