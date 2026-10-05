import { PrismaClient } from '@prisma/client';
import * as appointmentService from '../services/ledger/appointmentService.js';

// Appointments are a ledger concern - gated behind the same three layers as the
// rest of the ledger, stored in the same Prisma schema, erased by the same
// consent sweep - so they are handled here rather than in health.js, where the
// gate shape is a single flag and there is no per-person consent to check.
//
// The handlers are parse/delegate/wrap, and the rules live in
// appointmentService. That split is not style: every rule enforced here would be
// a rule the next controller forgets, and the rules here are the ones that keep
// one user's appointments out of another user's list.
const prisma = new PrismaClient();

function handle(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req);
      return res.json({ data });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[appointments]', err);
      return res.status(status).json({
        error: err.error || err.message || 'Server error',
        code: err.code,
      });
    }
  };
}

export const listAppointments = handle(async (req) => {
  const { from, to, limit } = req.query || {};
  return appointmentService.listAppointments(prisma, {
    // From req.userId, never from the query. A userId in a query string would let
    // a caller read somebody else's appointments by editing a URL.
    userId: req.userId,
    from,
    to,
    limit,
  });
});

export const getAppointment = handle(async (req) =>
  appointmentService.getAppointment(prisma, {
    userId: req.userId,
    id: req.params.id,
  }),
);

export const createAppointment = handle(async (req) => {
  const b = req.body || {};
  return appointmentService.createAppointment(prisma, {
    userId: req.userId,
    doctorName: b.doctorName,
    speciality: b.speciality,
    localDate: b.localDate,
    localTime: b.localTime,
    followUpDate: b.followUpDate,
    notes: b.notes,
  });
});

// Keys are copied by PRESENCE, not by listing them. The service distinguishes
// "field absent" from "field sent as null" - that difference is how a client
// clears a time it no longer knows - and forwarding `undefined` for a key the
// client did not send would turn every partial update into a full one, wiping
// the speciality and notes on every correction to a time.
const PATCHABLE = [
  'doctorName',
  'speciality',
  'localDate',
  'localTime',
  'followUpDate',
  'notes',
];

export const updateAppointment = handle(async (req) => {
  const b = req.body || {};
  const input = { userId: req.userId, id: req.params.id };
  for (const key of PATCHABLE) {
    if (key in b) input[key] = b[key];
  }
  return appointmentService.updateAppointment(prisma, input);
});

export const deleteAppointment = handle(async (req) =>
  appointmentService.deleteAppointment(prisma, {
    userId: req.userId,
    id: req.params.id,
  }),
);

// Reads, not writes, so there is no `next` in the URL and no way to tell this
// apart from a create by looking at the verb. The alternative - POSTing
// "what's next?" - would put a read behind a write gate, and would make a screen
// load look like a mutation in every access log worth reading.
//
// nowDate and nowTime are the CALLER's local clock, and there is deliberately no
// server-side fallback. Appointments are stored in the user's own calendar zone
// while this server runs on UTC, so at 8pm on the 5th in California the server
// already thinks it is the 6th - and would then report tomorrow's appointment as
// next while tonight's, two hours away, went unmentioned. A default here would be
// wrong for every user east of Greenwich or west of Hawaii, and silently so.
// Asking is cheap: the app that calls this already knows its own date.
export const getNextAppointment = handle(async (req) => {
  const q = req.query || {};
  return appointmentService.nextAppointment(prisma, {
    userId: req.userId,
    nowDate: q.nowDate ?? q.from,
    nowTime: q.nowTime,
  });
});