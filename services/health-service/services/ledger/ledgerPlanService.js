// Plan items: what the plan says, who said it, and whether it happened today.
//
// The single most important rule in this file is that `origin: 'doctor'` is
// WRITABLE ONLY FROM THE CALLER'S OWN TEXT. There is exactly one function that
// can produce a doctor item, `addUserEnteredItem` with `fromPrescription: true`,
// and it takes a title the user typed. Nothing in this service, the generator,
// the assistant, or any route can invent one. The generator physically cannot
// emit a doctor item either - see planGenerator.js, which has a test asserting
// it.
//
// That boundary is what keeps this inside CDSCO general-wellness framing. A
// plan that says "take this medicine" and originated from us is us prescribing.
// The same words typed by the user off their own prescription are the user
// keeping track of their own advice.
//
// Everything else here is bookkeeping: schedules, the active-item cap, and
// completions. Suggested-row (re)writing lives in services/plan/rebuildPlan.js
// — there is exactly one rebuild implementation, and it is not this file's.
import {
  MAX_ACTIVE_PLAN_ITEMS,
  LATE_LOGGING_WINDOW_DAYS,
} from './constants.js';

// The kinds a user-entered item may carry. This list is the database enum and
// nothing else: health.PlanItemKind in the Prisma schema, which is the seven
// values created by the add_health_ledger migration.
//
// It has to be the enum exactly, in BOTH directions, and the reason is a bug
// this list used to have in both directions at once. It read
// ['nutrition','workout','habit','appointment','custom'], which:
//
//   - Rejected all four doctor and rest kinds. The client's dropdown offers the
//     Prisma enum, so every 'Medication', 'Test', 'Appointment' and 'Rest'
//     selection came back 400 — which meant the entire doctor scoring path
//     (scoreEngine's +/-10 doctor points, remediation ranking a missed
//     medication above a missed workout) was implemented on both sides and
//     unreachable from the UI.
//
//   - Accepted 'appointment' and 'custom', which are NOT in the enum. Those
//     passed validation here and then died inside Prisma with a
//     PrismaClientValidationError, so a bad kind surfaced as an opaque 500
//     instead of the 400 the caller was told to expect. A value this list
//     admits but the database does not is worse than a value it rejects: the
//     rejection is actionable and the crash is not.
//
// So this is derived from the schema and pinned by a test against the migration
// (test/planItemKinds.test.js). If a kind is added to the enum, add it here in
// the same commit — the test fails otherwise.
const PLAN_ITEM_KINDS = [
  'nutrition',
  'workout',
  'habit',
  'doctor_medication',
  'doctor_test',
  'doctor_appointment',
  'rest',
];

// Exported so a test can pin it against the migration that creates the enum,
// rather than against a hand-kept copy of the same list.
export { PLAN_ITEM_KINDS };

// What an item with no stated kind becomes.
//
// It has to be a member of the list above, and it is named here rather than
// inlined in the signature because the previous inline default was 'custom',
// which is not a kind at all. Every caller that relied on the default — the
// controller passing an absent body field, the AI injection, and four existing
// tests — started throwing a kind error the moment the allow-list stopped
// lying about what the database accepts.
//
// 'habit' because that is the kind the client's own "Add to your plan" dialog
// starts on, so an item with no stated kind lands where the user would have
// left it.
const DEFAULT_PLAN_ITEM_KIND = 'habit';

// The kinds a user-entered row may carry when the one-plan wire sends
// `ownKind` (see addUserEnteredItem). A user row is a habit or a workout and
// nothing else: 'nutrition', the doctor kinds and 'rest' are not things a
// person adds by hand from the today screen.
const OWN_KINDS = ['habit', 'workout'];

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

/**
 * Is this item due on this local date?
 *
 * Supports the four schedule shapes the schema documents: 'daily', 'weekly',
 * a comma-separated ISO weekday list, and a single 'YYYY-MM-DD'. Also handles
 * 'every_other_day' (alternate days), which is expressed as a cadence against
 * the item's createdAt date.
 *
 * A malformed schedule returns false rather than throwing. A plan item with a
 * corrupt schedule should stop counting, not take down the whole day's score
 * or 500 the screen.
 */
export function isDueOn(item, localDate, today) {
  // Validate the date before anything else. A 'daily' item would otherwise
  // return true for a malformed localDate purely because the schedule check
  // came first, so a corrupt date would read as "every item is due".
  if (!DATE_RE.test(String(localDate || ''))) return false;

  const schedule = String(item.schedule || 'daily').trim().toLowerCase();

  if (DATE_RE.test(schedule)) return schedule === localDate;

  if (schedule === 'every_other_day') {
    const anchor = String(item.createdAt || '').slice(0, 10);
    if (!DATE_RE.test(anchor) || !DATE_RE.test(localDate) || !DATE_RE.test(today)) return false;
    const start = Date.parse(`${anchor}T00:00:00Z`);
    const day = Date.parse(`${localDate}T00:00:00Z`);
    const now = Date.parse(`${today}T00:00:00Z`);
    if ([start, day, now].some(Number.isNaN)) return false;
    // Before the anchor there is nothing to alternate from, so the item is not
    // yet due rather than retroactively alternating.
    if (day < start) return false;
    return Math.round((day - start) / 86400000) % 2 === 0 && day <= now;
  }

  if (schedule === 'daily') return true;
  if (schedule === 'weekly') return true;

  const days = schedule.split(/[,\s]+/).filter(Boolean);
  if (!days.length) return false;

  // Bare numbers are weekdays, 1 = Monday. Without this an item scheduled
  // "7" either never matched or matched every day, depending on how it was
  // read.
  const normalised = days.map((d) => (/^[1-7]$/.test(d) ? WEEKDAYS[Number(d) - 1] : d));
  if (normalised.some((d) => !WEEKDAYS.includes(d))) return false;

  const date = new Date(`${localDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  return normalised.includes(WEEKDAYS[(date.getDay() + 6) % 7]);
}

// Ticks are counted in the user's zone, the same zone the app derives localDate
// from. A tick made at 00:30 IST belongs to that IST day, not the UTC one.
function istDateString(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// A tick for a future date is always wrong: a timezone mistake upstream must
// not write a completion the day has not reached. A past date is allowed only
// inside LATE_LOGGING_WINDOW_DAYS — beyond it the plan has moved on and the
// tick is refused rather than silently recorded. `today` is optional so callers
// without a today payload are unaffected.
function assertTickableDate(localDate, today) {
  if (!today || !DATE_RE.test(String(today))) return;
  const day = Date.parse(`${localDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(day) || Number.isNaN(now)) return;
  const diffDays = Math.round((day - now) / 86400000);
  if (diffDays > 0) throw badRequest('You cannot tick a future date');
  if (diffDays < -LATE_LOGGING_WINDOW_DAYS) {
    throw badRequest('That day is closed for logging');
  }
}

// Late means recorded after the day it counts for. The completion only stores
// createdAt, so compare its zone-local date to the localDate the tick is for:
// equal for an on-time tick, later for a backfilled one.
function isLateTick(row, localDate) {
  const recorded = istDateString(row.createdAt);
  return recorded != null && recorded > localDate;
}

/**
 * Add a plan item the user typed themselves.
 *
 * `fromPrescription` is the only path that can set origin 'doctor', and it
 * sets it because the user said so. There is no other caller, no flag from the
 * client that can be spoofed into it (it is a function argument chosen by this
 * service, not read from the request body), and the title is whatever the user
 * typed.
 *
 * `ownKind` (the one-plan wire contract for user rows) must be 'habit' or
 * 'workout' and is stored in the existing `kind` column — the wire shape has
 * no separate kind field for own rows. A caller that passes only the legacy
 * `kind` keeps the old validation; either way the row's layerKey is 'own' for
 * user rows and 'medicine' for doctor rows, which is what lets
 * getPlanForDate's layer filter treat them like any other row.
 */
export async function addUserEnteredItem(prisma, { userId, title, kind = DEFAULT_PLAN_ITEM_KIND, ownKind = null, schedule = 'daily', endsOn = null, fromPrescription = false, prescribedBy = null, prescribedNote = null }) {
  const clean = String(title || '').trim();
  if (!clean) throw badRequest('An item needs a title');
  // ownKind is the one-plan wire field for user rows; it lands in the same
  // `kind` column. A legacy caller that sends only `kind` is still validated
  // against the enum below, so both shapes behave identically.
  const resolvedKind = ownKind != null ? ownKind : kind;
  if (ownKind != null && !OWN_KINDS.includes(ownKind)) {
    throw badRequest(`ownKind must be one of: ${OWN_KINDS.join(', ')}`);
  }
  if (!PLAN_ITEM_KINDS.includes(resolvedKind)) {
    throw badRequest(`kind must be one of: ${PLAN_ITEM_KINDS.join(', ')}`);
  }

  // The title is the user's own words, but it is still untrusted input that
  // other people will read on a shared screen, so it is length-capped and
  // never interpreted.
  if (clean.length > 200) throw badRequest('That title is too long');

  const active = await prisma.planItem.count({ where: { userId, active: true } });
  if (active >= MAX_ACTIVE_PLAN_ITEMS) {
    throw badRequest(
      `Your plan already has ${MAX_ACTIVE_PLAN_ITEMS} active items. Remove one to add another.`,
    );
  }

  return prisma.planItem.create({
    data: {
      userId,
      kind: resolvedKind,
      title: clean,
      schedule: String(schedule || 'daily').trim() || 'daily',
      origin: fromPrescription ? 'doctor' : 'user',
      layerKey: fromPrescription ? 'medicine' : 'own',
      prescribedBy: fromPrescription ? String(prescribedBy || '').trim() || null : null,
      prescribedNote: fromPrescription ? String(prescribedNote || '').trim() || null : null,
      endsOn,
      active: true,
      autoGenerated: false,
    },
  });
}

/**
 * Tick an item for a date.
 *
 * Idempotent: the unique (planItemId, localDate) makes a second tap an update
 * rather than a double count.
 *
 * Every tick is written `how:'manual'`. The old `how:'auto'` / 0-point branch is
 * gone: automatic satisfaction (a workout the session log already credited) is
 * reconciled by the score engine, which reads completions and decides what a
 * row is worth. This function only records that the person ticked the row.
 *
 * So `points` here is a fixed 1, not a grant. The engine owns the real award
 * (and the late-tick 0); a client-supplied point value would let any client
 * mint score for itself, which is why none is accepted.
 *
 * The server rejects a future date (400). A past date is accepted only inside
 * LATE_LOGGING_WINDOW_DAYS; the engine then values it at 0. `today` is optional
 * so existing callers that do not pass it keep working.
 */
export async function completeItem(prisma, { userId, itemId, planItemId = null, localDate, today = null }) {
  const id = Number(itemId ?? planItemId);
  if (!Number.isInteger(id)) throw badRequest('A plan item id is required');
  if (!DATE_RE.test(String(localDate || ''))) throw badRequest('A date is required');
  assertTickableDate(localDate, today);

  const item = await prisma.planItem.findFirst({ where: { id, userId } });
  if (!item) throw notFound('No such plan item');
  if (!item.active) throw badRequest('That item is not active');

  return prisma.planItemCompletion.upsert({
    where: { planItemId_localDate: { planItemId: item.id, localDate } },
    create: { planItemId: item.id, userId, localDate, points: 1, how: 'manual' },
    update: { points: 1, how: 'manual' },
  });
}

/**
 * Undo a manual tick.
 *
 * Only `how:'manual'` rows are deleted. An automatic completion is not the
 * user's to undo — it reflects the session log, and deleting it would desync
 * the day from the log until the next rebuild. When the only completion for
 * (item, date) is automatic this throws 409 AUTO_DONE rather than silently
 * doing nothing, so the client can say "this one counts from your workout".
 */
export async function uncompleteItem(prisma, { userId, itemId, planItemId = null, localDate }) {
  const id = Number(itemId ?? planItemId);
  if (!Number.isInteger(id)) throw badRequest('A plan item id is required');
  if (!DATE_RE.test(String(localDate || ''))) throw badRequest('A date is required');

  const { count } = await prisma.planItemCompletion.deleteMany({
    where: { userId, planItemId: id, localDate, how: 'manual' },
  });
  if (count === 0) {
    const err = new Error('That row is satisfied automatically and cannot be unticked');
    err.status = 409;
    err.code = 'AUTO_DONE';
    throw err;
  }
  return { deleted: count };
}

/**
 * Items due today, with their completion state for the date.
 *
 * Only rows on an unlocked layer are returned. `onLayerKeys` already includes
 * 'own' and, when allowed, 'medicine'; a row whose layerKey is null (legacy
 * pre-layer row) is dropped, because a lock is a real lock. When no
 * `onLayerKeys` is given the filter is skipped, matching the pre-journey
 * behaviour for callers that have no layer context yet.
 *
 * Each row carries `completion: {how, late} | null`. `how` is the wire value —
 * 'tick' for a manual tick, 'auto' for the automatic rule, which is what the
 * app reads (the DB stores 'manual').
 * `late` is true when the tick was recorded after the day it counts for: the
 * completion's createdAt (in the user's zone) is a later date than localDate,
 * which is exactly a backfilled tick inside the late window.
 *
 * `completed` (bool) is kept alongside `completion` for callers not yet moved
 * onto the richer shape.
 */
export async function getPlanForDate(prisma, { userId, localDate, onLayerKeys = null, today = null }) {
  const items = await prisma.planItem.findMany({
    where: { userId, active: true },
    include: { completions: { where: { localDate } } },
    orderBy: [{ kind: 'asc' }, { id: 'asc' }],
  });

  const due = [];
  for (const item of items) {
    if (Array.isArray(onLayerKeys) && !(item.layerKey != null && onLayerKeys.includes(item.layerKey))) {
      continue;
    }
    // "until the 5th", inclusive. The comparison is a string compare because
    // both sides are 'YYYY-MM-DD', which sorts as a date — but only if both are
    // actually that shape. A single malformed endsOn used to expire the item
    // permanently: '2026-2-1' sorts below '2026-10-05', so every date after it
    // read as past the end. Wrongly dropping a live item is the worse failure
    // here, so an unparseable end date is ignored and the item stays due.
    if (item.endsOn && DATE_RE.test(item.endsOn) && localDate > item.endsOn) continue;
    if (!isDueOn(item, localDate, today)) continue;

    const { completions, ...rest } = item;
    const row = (completions || [])[0] || null;
    const completion = row
      ? { how: row.how === 'manual' ? 'tick' : row.how, late: isLateTick(row, localDate) }
      : null;

    due.push({ ...rest, completion, completed: row != null });
  }

  const completedCount = due.reduce((n, item) => (item.completed ? n + 1 : n), 0);
  return { localDate, items: due, total: due.length, completedCount };
}

export async function deactivateItem(prisma, { userId, planItemId }) {
  const item = await prisma.planItem.findFirst({ where: { id: Number(planItemId), userId } });
  if (!item) throw notFound('No such plan item');
  // Deactivate, never delete. Past days reference these rows through their
  // completions, and a frozen score has to stay explicable.
  return prisma.planItem.update({ where: { id: item.id }, data: { active: false } });
}
