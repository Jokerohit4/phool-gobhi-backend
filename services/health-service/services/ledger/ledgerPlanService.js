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
// Everything else here is bookkeeping: schedules, the active-item cap,
// completions, and regenerating suggested items without touching anyone's.
import {
  MAX_ACTIVE_PLAN_ITEMS,
  DECIMAL_PLACES,
  roundTo,
} from './constants.js';
import { generatePlan } from './planGenerator.js';

const PLAN_ITEM_KINDS = ['nutrition', 'workout', 'habit', 'appointment', 'custom'];
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

/**
 * Add a plan item the user typed themselves.
 *
 * `fromPrescription` is the only path that can set origin 'doctor', and it
 * sets it because the user said so. There is no other caller, no flag from the
 * client that can be spoofed into it (it is a function argument chosen by this
 * service, not read from the request body), and the title is whatever the user
 * typed.
 */
export async function addUserEnteredItem(prisma, { userId, title, kind = 'custom', schedule = 'daily', endsOn = null, fromPrescription = false, prescribedBy = null, prescribedNote = null }) {
  const clean = String(title || '').trim();
  if (!clean) throw badRequest('An item needs a title');
  if (!PLAN_ITEM_KINDS.includes(kind)) {
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
      kind,
      title: clean,
      schedule: String(schedule || 'daily').trim() || 'daily',
      origin: fromPrescription ? 'doctor' : 'user',
      prescribedBy: fromPrescription ? String(prescribedBy || '').trim() || null : null,
      prescribedNote: fromPrescription ? String(prescribedNote || '').trim() || null : null,
      endsOn,
      active: true,
      autoGenerated: false,
    },
  });
}

/**
 * Replace the SUGGESTED items, leaving user and doctor items untouched.
 *
 * This is the whole reason PlanItem.autoGenerated exists. "Regenerate my plan"
 * has to be safe to press: if it deleted a doctor's course of tablets because
 * the new target had a different protein number, the feature would be
 * dangerous rather than convenient.
 */
export async function regenerateSuggestions(prisma, { userId, goal, diet, targets, measuredActivity }) {
  if (!targets) throw badRequest('Set a nutrition target before generating a plan');

  const activeCount = await prisma.planItem.count({ where: { userId, active: true } });
  const userItems = await prisma.planItem.count({
    where: { userId, active: true, origin: { in: ['user', 'doctor'] } },
  });
  // A user's own and doctor's items are permanent as far as regeneration is
  // concerned, so they do not consume the room the generated items have. The
  // cap that matters for them is the one addUserEnteredItem enforces.
  const room = Math.max(0, MAX_ACTIVE_PLAN_ITEMS - userItems);

  const hasDoctorItems = (await prisma.planItem.count({
    where: { userId, origin: 'doctor', active: true },
  })) > 0;

  const { items: suggestions, trimmedFrom } = generatePlan({
    goal,
    diet,
    targets,
    measuredActivity,
    hasDoctorItems,
  });
  const keptSuggestions = suggestions.slice(0, room);

  // Soft-delete rather than delete: an item someone already ticked stays
  // visible in past days, and a hard delete would cascade its completions and
  // rewrite a frozen score.
  await prisma.planItem.updateMany({
    where: { userId, origin: 'suggested', active: true },
    data: { active: false },
  });

  const created = [];
  for (const item of keptSuggestions) {
    created.push(
      await prisma.planItem.create({
        data: {
          userId,
          kind: item.kind,
          title: item.title,
          schedule: item.schedule,
          // Hard-set, and asserted in the generator's tests. A suggested item
          // that claimed to come from a doctor would break the whole boundary.
          origin: 'suggested',
          nutrientKey: item.nutrientKey || null,
          targetValue: item.targetValue != null ? roundTo(item.targetValue, DECIMAL_PLACES.nutrients) : null,
          active: true,
          autoGenerated: true,
        },
      }),
    );
  }

  // `trimmed` is what the generator wanted to propose, `room` is how many
  // there was space for, and `dropped` is the difference. Surfaced so the app
  // can say "your plan is full" rather than handing back a short plan with no
  // explanation.
  const generatedBeforeRoomLimit = trimmedFrom ?? suggestions.length;
  return {
    created: created.length,
    kept: userItems,
    dropped: Math.max(0, generatedBeforeRoomLimit - keptSuggestions.length),
    room,
    items: created,
  };
}

/**
 * Tick an item for a date. Idempotent: the unique (planItemId, localDate) makes
 * a second tap an update rather than a double count.
 */
export async function completeItem(prisma, { userId, planItemId, localDate, points = 0, how = 'manual' }) {
  const item = await prisma.planItem.findFirst({ where: { id: Number(planItemId), userId } });
  if (!item) throw notFound('No such plan item');
  if (!item.active) throw badRequest('That item is not active');

  // A tick is worth exactly one point, always. The value is derived here rather
  // than accepted from the caller because a client-supplied point value would
  // let any client mint score for itself - and `how: 'auto'` is worth zero,
  // since an auto-satisfied item (a workout the session log already credited)
  // must not score twice.
  const isManual = how !== 'auto';
  const earned = isManual ? 1 : 0;

  return prisma.planItemCompletion.upsert({
    where: { planItemId_localDate: { planItemId: item.id, localDate } },
    create: { planItemId: item.id, userId, localDate, points: earned, how },
    update: { points: earned, how },
  });
}

/**
 * Items due today, with their completion state for the date.
 */
export async function getPlanForDate(prisma, { userId, localDate, today }) {
  const items = await prisma.planItem.findMany({
    where: { userId, active: true },
    include: { completions: { where: { localDate } } },
    orderBy: [{ kind: 'asc' }, { id: 'asc' }],
  });

  const due = [];
  for (const item of items) {
    if (item.endsOn && localDate > item.endsOn) continue;
    if (!isDueOn(item, localDate, today)) continue;
    due.push({
      ...item,
      completed: (item.completions || []).length > 0,
    });
  }

  return { localDate, items: due, total: due.length };
}

export async function deactivateItem(prisma, { userId, planItemId }) {
  const item = await prisma.planItem.findFirst({ where: { id: Number(planItemId), userId } });
  if (!item) throw notFound('No such plan item');
  // Deactivate, never delete. Past days reference these rows through their
  // completions, and a frozen score has to stay explicable.
  return prisma.planItem.update({ where: { id: item.id }, data: { active: false } });
}
