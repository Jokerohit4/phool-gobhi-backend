// Doctor's appointments, as their own record rather than as plan items.
//
// WHY THIS EXISTS ALONGSIDE PlanItem
// ===================================
//
// Appointments currently live in PlanItem with kind 'doctor_appointment', and
// the score engine reads those. That path works and is untouched by this file.
// What it cannot express is what makes an appointment an appointment rather
// than a thing to do on a day:
//
//   localTime     A plan item is a DAY. An appointment is a wall-clock moment,
//                 and the schema comment says why that matters: 10:30 at a
//                 clinic in Gurugram is not a UTC instant, and a reminder has to
//                 fire against the user's own clock. There is nowhere in
//                 PlanItem to put that.
//
//   followUpDate  A plan item's `endsOn` means "stop scoring me after this".
//                 A follow-up means "ask me again on this other date". Those are
//                 opposite meanings on two similarly-named columns, which is the
//                 kind of similarity that produces a bug nobody notices for a
//                 year.
//
//   notes         A plan item has a title. A clinical note is free text the
//                 user typed from what a doctor said.
//
//   speciality    Nothing to do with whether you did it.
//
// So the table is kept, and this file gives it a writer. The deliberate
// consequence, and it is a consequence rather than an accident:
//
//   SCORING IS NOT MOVED. The score engine still reads PlanItem. An appointment
//   written through here does not earn or lose points, and an existing PlanItem
//   appointment keeps scoring exactly as it does today. Migrating scoring later
//   will mean rows on both sides to compare against, which is worth more than a
//   clean cut made while there is no data to check the cut against.
//
//   NO BACKFILL. Existing PlanItem appointments stay where they are and keep
//   scoring. Copying them into this table would double them the moment scoring
//   does move, and would silently change every historical score in between.
//
//   TWO TRUTHS, ONE USER. A user can have an appointment in the ledger and an
//   appointment record here, and that is honest rather than a bug: one is a
//   thing they are scored on, the other is the appointment itself. Nothing in
//   this file reconciles them, because reconciling them is the scoring
//   migration's job and doing it early is the bug.
//
// WHAT IS NOT HERE, ON PURPOSE
// ============================
//
// No AI, and nothing that infers a doctor instruction. Nothing here writes
// PlanItem, so an appointment record cannot become a scored instruction by
// accident, and nothing here reads a prescription to guess at a follow-up
// window. An appointment is something the user tells us about a real booking
// they made with a real person; guessing one would put a fabricated date in
// front of a reminder.
import { track } from '../../utils/analytics.js';

// 'YYYY-MM-DD' and 'HH:mm', stored as strings rather than timestamps.
//
// Strings are the right type for both. A doctor's appointment is a wall-clock
// time in the user's own zone, and storing it as a timestamptz would mean
// picking a zone on write - and picking wrong either loses the appointment when
// the clocks change or shows it at the wrong hour forever. This is the same
// reasoning as PlanItem.localDate and as the schema comment on this table.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DOCTOR_NAME_MAX = 80;
const SPECIALITY_MAX = 60;
const NOTES_MAX = 1000;

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

function notFound() {
  return Object.assign(new Error('No such appointment'), {
    status: 404,
    code: 'NO_SUCH_APPOINTMENT',
  });
}

/**
 * The user's own appointments.
 *
 * Scoped by userId on every read, which is the whole of the access control
 * here: an id is guessable (they are sequential), so a read that filtered on
 * id alone would hand one user another user's doctor, their appointment date
 * and their notes.
 *
 * Ordered by date, then time, then creation. Past-to-future is what a calendar
 * wants, and an appointment with no time sorts ahead of one that has one on the
 * same day - which is right, since "sometime on the 14th" is vaguer than
 * "10:30 on the 14th" and listing the vaguer one second invites the question
 * of why the order is wrong.
 */
export async function listAppointments(
  prisma,
  { userId, from, to, limit = 100 } = {},
) {
  return prisma.doctorAppointment.findMany({
    where: {
      userId,
      // Both bounds are validated before they get here, so these are strings
      // that match DATE_RE rather than arbitrary user input in a query.
      ...(from ? { localDate: { gte: from } } : {}),
      ...(to ? { localDate: { lte: to } } : {}),
    },
    orderBy: [{ localDate: 'asc' }, { localTime: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(Number(limit) || 100, 200),
  });
}

/**
 * One appointment, or 404.
 *
 * findFirst with both id and userId rather than findUnique on id: the
 * difference between "no such appointment" and "not yours" is one that tells an
 * attacker this id exists.
 */
export async function getAppointment(prisma, { userId, id }) {
  const appointment = await prisma.doctorAppointment.findFirst({
    where: { id: toId(id), userId },
  });
  if (!appointment) throw notFound();
  return appointment;
}

/**
 * Records an appointment the user has booked.
 *
 * Validated rather than trusted. A malformed localDate would sort wrong and
 * render wrong and be unfixable later, and a followUpDate earlier than the
 * appointment itself is either a typo or a date the service should refuse to
 * hold rather than surface in a reminder.
 */
export async function createAppointment(
  prisma,
  { userId, doctorName, speciality, localDate, localTime, followUpDate, notes } = {},
) {
  const cleanDoctor = clamp(doctorName, DOCTOR_NAME_MAX);
  if (!cleanDoctor) {
    throw badRequest('Who is the appointment with?', 'DOCTOR_REQUIRED');
  }

  const cleanDate = requireDate(localDate, 'DATE_REQUIRED', 'Pick a date for the appointment');

  // A time is optional and a follow-up is optional, and both are validated
  // separately rather than together: "you left the date blank" is a different
  // correction from "that time is not a time", and a user fixing one typo
  // should not be told about the other.
  const cleanTime = localTime ? requireTime(localTime) : null;

  const cleanFollowUp = followUpDate ? requireDate(followUpDate, 'FOLLOWUP_INVALID') : null;
  if (cleanFollowUp && cleanFollowUp < cleanDate) {
    // Rejected rather than swapped. Silently correcting it would produce a
    // reminder about a date the appointment already happened on.
    throw badRequest('A follow-up cannot be before the appointment', 'FOLLOWUP_BEFORE_APPOINTMENT');
  }

  const appointment = await prisma.doctorAppointment.create({
    data: {
      userId,
      doctorName: cleanDoctor,
      speciality: clamp(speciality, SPECIALITY_MAX),
      localDate: cleanDate,
      localTime: cleanTime,
      followUpDate: cleanFollowUp,
      notes: clamp(notes, NOTES_MAX),
    },
  });

  // Shape, never content. A doctor, a date and a note are all health data and
  // the analytics util has a no-PII rule; "an appointment was recorded" is the
  // most this event can honestly carry. Not on the update path either - a
  // correction is not a new booking.
  track('health_doctor_appointment_recorded', userId, {});
  return appointment;
}

/**
 * Edits an existing appointment.
 *
 * A partial update: only the keys present in `input` are written. A PUT that
 * nulled the omitted fields would silently erase a speciality or a note every
 * time someone corrected a time, which is the kind of data loss that is only
 * noticed when somebody goes back to check what a doctor said.
 */
export async function updateAppointment(prisma, { userId, id, ...input } = {}) {
  const existing = await prisma.doctorAppointment.findFirst({
    where: { id: toId(id), userId },
  });
  if (!existing) throw notFound();

  const data = {};

  if ('doctorName' in input) {
    const clean = clamp(input.doctorName, DOCTOR_NAME_MAX);
    if (!clean) throw badRequest('Who is the appointment with?', 'DOCTOR_REQUIRED');
    data.doctorName = clean;
  }
  if ('speciality' in input) data.speciality = clamp(input.speciality, SPECIALITY_MAX);
  if ('notes' in input) data.notes = clamp(input.notes, NOTES_MAX);

  // Cleared explicitly rather than treated as absent. `localTime: null` is how
  // a client says "I no longer know what time", which is different from not
  // mentioning the field.
  if ('localTime' in input) {
    data.localTime = input.localTime ? requireTime(input.localTime) : null;
  }

  // Dates are validated against each other after the merge, not against each
  // other other's old values: moving an appointment to after its own follow-up
  // is as wrong as having been born with one, and checking only the incoming
  // pair would let it through.
  const nextDate = 'localDate' in input ? requireDate(input.localDate) : existing.localDate;
  const nextFollowUp =
    'followUpDate' in input
      ? input.followUpDate
        ? requireDate(input.followUpDate)
        : null
      : existing.followUpDate;

  if ('localDate' in input) data.localDate = nextDate;
  if ('followUpDate' in input) data.followUpDate = nextFollowUp;

  if (nextFollowUp && nextFollowUp < nextDate) {
    throw badRequest('A follow-up cannot be before the appointment', 'FOLLOWUP_BEFORE_APPOINTMENT');
  }

  return prisma.doctorAppointment.update({ where: { id: existing.id }, data });
}

/**
 * Removes one appointment.
 *
 * The user's own record of a booking they made, so deleting it is not erasure -
 * it is the ordinary "that got cancelled" path, and it should not need an
 * account deletion to express. Account-level erasure is a separate, broader
 * thing and lives in consentService.
 */
export async function deleteAppointment(prisma, { userId, id }) {
  const existing = await prisma.doctorAppointment.findFirst({
    where: { id: toId(id), userId },
  });
  if (!existing) throw notFound();

  await prisma.doctorAppointment.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}

/**
 * The next appointment on or after `from`, or null.
 *
 * Exists for reminders, so it deliberately does not filter out past times on the
 * current day: a reminder fired for 10:30 that runs at 10:29 has not missed yet,
 * and one that runs at 10:31 should still say "it's now" rather than nothing.
 */
export async function nextAppointment(prisma, { userId, from, now = new Date() }) {
  const today = from || now.toISOString().slice(0, 10);
  const currentTime = now.toISOString().slice(11, 16);

  const candidates = await prisma.doctorAppointment.findMany({
    where: { userId, localDate: { gte: today } },
    orderBy: [{ localDate: 'asc' }, { localTime: 'asc' }, { createdAt: 'asc' }],
    take: 25,
  });

  // Filtered in JS rather than in the query because "today, any time" and
  // "today, only times still ahead" are two different predicates on an optional
  // column, and expressing the second in Prisma's DSL costs more than reading
  // 25 rows.
  return (
    candidates.find((a) => a.localDate > today || !a.localTime || a.localTime >= currentTime) ||
    null
  );
}

function requireDate(value, code, message) {
  const date = String(value ?? '').trim();
  if (!DATE_RE.test(date)) {
    throw badRequest(message || 'That is not a date', code || 'DATE_INVALID');
  }
  // Shape is not validity. '2026-02-31' and '2026-13-01' both match DATE_RE and
  // both are impossible, and a Date parses the former to 3 March silently -
  // which would store an appointment on a day the user never agreed to.
  const [y, m, d] = date.split('-').map(Number);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (
    asDate.getUTCFullYear() !== y ||
    asDate.getUTCMonth() !== m - 1 ||
    asDate.getUTCDate() !== d
  ) {
    throw badRequest('That is not a real date', code || 'DATE_INVALID');
  }
  return date;
}

function requireTime(value) {
  const time = String(value ?? '').trim();
  if (!TIME_RE.test(time)) {
    throw badRequest('That is not a time', 'TIME_INVALID');
  }
  return time;
}

function toId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw badRequest('Bad appointment id', 'BAD_ID');
  return id;
}

function clamp(value, max) {
  const trimmed = String(value ?? '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : null;
}