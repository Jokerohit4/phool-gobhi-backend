import { isoDayIST } from '../utils/sessionDay.js';
import { routineSnapshot, recordRoutineWater } from './routineJourneyService.js';
// The daily habits: water and supplements (B11).
//
// Two surfaces the coach journey's Plan tab and Home read every day, kept in
// one service because they share a shape — both are "a day's worth of small
// ticks against a target the plan owns":
//
//   water       - one row per drink against the prescription's water figure.
//                 The target is never taken from the client: it comes from the
//                 SAME place the plan read gets it (currentNutritionTarget),
//                 falling back to the journey default when no target exists,
//                 so the habits screen and the Plan tab can never disagree
//                 about what "enough water" means for one person on one day.
//   supplements - a schedule the user writes in their own words, and a tick
//                 per day per schedule. The tick outlives the schedule (the
//                 schema has no relation, so deleting a schedule keeps the
//                 history of having taken it), and nothing here ever suggests
//                 a supplement or a dose — this is the habit half of the plan,
//                 not the medical half.
//
// B10's water habit item reads the same sum against the same target, so the
// score and the tick state stay one fact.
import { isIsoDay } from './ledger/isoDay.js';
import { currentNutritionTarget } from './ledger/currentTarget.js';

// The coach journey's default water, before any body data exists. Imported from
// journeyConfig to keep the two in sync.
import { JOURNEY } from './journey/journeyConfig.js';
import { rebuildPlan } from './plan/rebuildPlan.js';
const JOURNEY_DEFAULT_WATER_ML = JOURNEY.defaultWaterMl;

// Per-entry bounds from the Contracts. A drink, not a bucket: a per-entry cap
// is what makes "logged 4 L" impossible to fake with one tap.
export const MIN_WATER_ML = 50;
export const MAX_WATER_ML = 2000;

// The schedule cap. Ten named things is the point at which "I take these
// daily" stops being a habit list and starts being something a doctor should
// be reading.
export const MAX_SUPPLEMENTS = 10;

const NAME_MAX = 60;
// HH:MM, 24-hour, real clock values — "9:00" and "24:30" are refused, because
// a reminder the app cannot schedule is a reminder that silently never fires.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// IST is hardcoded for the same reason it is everywhere else in this service:
// every user is in India today (see dayCloseService.js for the standing note).
function todayLocalDate() {
  return isoDayIST(new Date());
}

function invalidDate() {
  return { status: 400, error: 'localDate must be YYYY-MM-DD', code: 'INVALID_DATE' };
}

function invalidWater() {
  return {
    status: 400,
    error: `Log between ${MIN_WATER_ML} and ${MAX_WATER_ML} ml at a time.`,
    code: 'INVALID_WATER_ML',
  };
}

function invalidSupplement(message) {
  return { status: 400, error: message, code: 'INVALID_SUPPLEMENT' };
}

function notFound(message) {
  return { status: 404, error: message, code: 'NOT_FOUND' };
}

// A day on the wire: the request's localDate when it gave one, the server's
// IST today when it did not. Validated rather than trusted — a malformed
// localDate would write rows no day query could ever match (see isoDay.js).
function resolveDay(localDate) {
  const day = localDate == null || localDate === '' ? todayLocalDate() : localDate;
  if (!isIsoDay(day)) throw invalidDate();
  return day;
}

/**
 * The prescription's water figure, or the journey default when there is none.
 *
 * Mirrors prescriptionService.buildPlan exactly: same source function, same
 * fallback, so /habits/today and /ledger/prescription answer with one number.
 */
export async function waterTargetMl(prisma, userId) {
  const target = await currentNutritionTarget(prisma, userId);
  return target ? Number(target.waterMl) : JOURNEY_DEFAULT_WATER_ML;
}

/**
 * The whole habits screen in one read: the water target, the day's drinks,
 * and every supplement schedule with whether it was taken on the day.
 *
 * `takenToday` is computed from the day's SupplementLog rows fetched once,
 * not one exists() query per schedule — the same "sum the rows" posture the
 * food log takes, and one query cheaper than the loop.
 */
export async function getToday(prisma, { userId, localDate } = {}) {
  const day = resolveDay(localDate);

  const [targetMl, waterLogs, schedules, dayLogs] = await Promise.all([
    waterTargetMl(prisma, userId),
    prisma.waterLog.findMany({
      where: { userId, localDate: day },
      orderBy: { id: 'asc' },
    }),
    prisma.supplementSchedule.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    }),
    prisma.supplementLog.findMany({ where: { userId, localDate: day } }),
  ]);

  const water = {
    targetMl,
    loggedMl: waterLogs.reduce((sum, l) => sum + Number(l.ml || 0), 0),
    logs: waterLogs.map((l) => ({ id: l.id, ml: l.ml })),
  };
  const supplements = schedules.map((s) => ({
    id: s.id,
    name: s.name,
    times: s.times || [],
    takenToday: dayLogs.some((l) => l.scheduleId === s.id),
  }));

  let routine = null;
  try { routine = await routineSnapshot(prisma, userId); } catch (error) {
    console.error('[routine] snapshot unavailable:', error.message);
  }
  return { water, supplements, routine };
}

/**
 * One drink. Returns the row id and the day's new total, so the client can
 * update the ring without a second read.
 */
export async function logWater(prisma, { userId, ml, localDate, requestId } = {}) {
  const amount = Number(ml);
  if (!Number.isInteger(amount) || amount < MIN_WATER_ML || amount > MAX_WATER_ML) {
    throw invalidWater();
  }
  const day = resolveDay(localDate);

  if (requestId != null && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(requestId))) {
    throw { status: 400, error: 'Invalid requestId', code: 'INVALID_REQUEST_ID' };
  }
  const key = requestId ? `water:${userId}:${requestId}` : null;
  let row = key ? await prisma.waterLog.findUnique({ where: { clientRequestId: key } }) : null;
  if (row && (row.localDate !== day || row.ml !== amount)) {
    throw { status: 409, error: 'Request already used for different water entry', code: 'REQUEST_CONFLICT' };
  }
  const replayed = !!row;
  if (!row) {
    try { row = await prisma.waterLog.create({ data: { userId, localDate: day, ml: amount,
      ...(key ? { clientRequestId: key } : {}) } }); }
    catch (error) {
      if (error.code !== 'P2002' || !key) throw error;
      row = await prisma.waterLog.findUnique({ where: { clientRequestId: key } });
      if (!row || row.localDate !== day || row.ml !== amount) throw { status: 409, error: 'Request conflict' };
    }
  }

  const total = await prisma.waterLog.aggregate({
    _sum: { ml: true },
    where: { userId, localDate: day },
  });

  let reward = { coinsAwarded: 0, pending: false };
  try {
    reward = await recordRoutineWater(prisma, { userId, localDate: day, replayed, now: row.createdAt, targetMl: await waterTargetMl(prisma, userId) });
  } catch (error) { console.error('[routine] water reward pending:', error.message); reward.pending = true; }
  return { id: row.id, loggedMl: Number(total._sum.ml || 0), reward };
}

/**
 * Undo one drink. Idempotent by construction: deleteMany scoped to the owner,
 * so a missing row, a double tap or someone else's row all end in the same
 * 204, and a junk id never reaches Prisma as NaN.
 */
export async function deleteWaterLog(prisma, { userId, id } = {}) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId)) return;
  await prisma.waterLog.deleteMany({ where: { id: rowId, userId } });
}

function cleanName(name) {
  if (typeof name !== 'string') {
    throw invalidSupplement('Give the supplement a name.');
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
    throw invalidSupplement(`The name must be 1-${NAME_MAX} characters.`);
  }
  return trimmed;
}

function cleanTimes(times) {
  if (times == null) return [];
  if (!Array.isArray(times)) {
    throw invalidSupplement('Times must be a list of HH:MM times.');
  }
  if (times.some((t) => !TIME_RE.test(String(t)))) {
    throw invalidSupplement('Times must be in HH:MM format, like 08:00 or 21:30.');
  }
  return times.map(String);
}

function cleanScheduleInput({ name, times, requireName = false }) {
  const hasName = name !== undefined;
  const hasTimes = times !== undefined;
  if (!hasName && !hasTimes) {
    throw invalidSupplement('Give a name or times to save.');
  }
  if (requireName && !hasName) {
    throw invalidSupplement('Give the supplement a name.');
  }
  const out = {};
  if (hasName) out.name = cleanName(name);
  if (hasTimes) out.times = cleanTimes(times);
  return out;
}

/**
 * The management list behind the supplements screen. Rows only — the
 * taken-today state lives on /habits/today, where the day is already loaded.
 */
export async function listSupplements(prisma, { userId } = {}) {
  const rows = await prisma.supplementSchedule.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    times: s.times || [],
    active: s.active,
  }));
}

export async function createSupplement(prisma, { userId, name, times } = {}) {
  const clean = cleanScheduleInput({ name, times, requireName: true });

  // Default times to empty array if not provided
  const timesToSave = clean.times ?? [];

  const count = await prisma.supplementSchedule.count({ where: { userId } });
  if (count >= MAX_SUPPLEMENTS) {
    throw {
      status: 400,
      error: `You can track up to ${MAX_SUPPLEMENTS} supplements.`,
      code: 'SUPPLEMENT_LIMIT',
    };
  }

  const row = await prisma.supplementSchedule.create({
    data: { userId, name: clean.name, times: timesToSave },
  });

  await rebuildPlan(prisma, userId, { reason: 'supplements' });

  return { id: row.id, name: row.name, times: row.times || [], active: row.active };
}

export async function updateSupplement(prisma, { userId, id, name, times } = {}) {
  const clean = cleanScheduleInput({ name, times });

  const existing = await prisma.supplementSchedule.findFirst({ where: { id: Number(id), userId } });
  if (!existing) throw notFound('Supplement not found.');

  const row = await prisma.supplementSchedule.update({
    where: { id: existing.id },
    data: clean,
  });

  await rebuildPlan(prisma, userId, { reason: 'supplements' });

  return { id: row.id, name: row.name, times: row.times || [], active: row.active };
}

/**
 * Remove a schedule. Hard delete, deliberately: the tick history is keyed by
 * scheduleId with no relation, so it survives (schema comment), and a
 * re-created schedule with the same name starts a fresh history rather than
 * inheriting someone else's ticks. Idempotent like the water delete — a
 * missing or foreign row is the same 204.
 */
export async function deleteSupplement(prisma, { userId, id } = {}) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId)) return;
  await prisma.supplementSchedule.deleteMany({ where: { id: rowId, userId } });

  await rebuildPlan(prisma, userId, { reason: 'supplements' });
}

/**
 * Tick a schedule for a day. Idempotent: the second tap on the same day
 * returns the first tick instead of writing a second row — a tick is "did I
 * take it", and the export reading two rows for one day would read as two
 * doses.
 */
export async function markTaken(prisma, { userId, id, localDate } = {}) {
  const schedule = await prisma.supplementSchedule.findFirst({
    where: { id: Number(id), userId },
  });
  if (!schedule) throw notFound('Supplement not found.');

  const day = resolveDay(localDate);

  const existing = await prisma.supplementLog.findFirst({
    where: { userId, scheduleId: schedule.id, localDate: day },
  });
  if (existing) {
    return { id: existing.id, scheduleId: existing.scheduleId, name: existing.name, localDate: existing.localDate };
  }

  const row = await prisma.supplementLog.create({
    data: { userId, scheduleId: schedule.id, name: schedule.name, localDate: day },
  });
  return { id: row.id, scheduleId: row.scheduleId, name: row.name, localDate: row.localDate };
}
