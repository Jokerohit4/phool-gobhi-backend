import * as bookingService from '../services/bookingService.js';
import * as exportService from '../services/exportService.js';

export const createBooking = async (req, res) => {
  try {
    // classId (optional): a recurring-class booking — date/startTime/endTime
    // are still required for a plain-slot booking, but for a class booking
    // only gymId/date/classId matter (the class's own schedule governs
    // startTime/endTime; see bookingService.createBooking).
    const { gymId, date, startTime, endTime, classId } = req.body;
    const booking = await bookingService.createBooking(req.userId, { gymId, date, startTime, endTime, classId });
    res.status(201).json({ data: booking });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMyBookings = async (req, res) => {
  try {
    const bookings = await bookingService.getCustomerBookings(req.userId);
    res.json({ data: bookings });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMyAttendanceSummary = async (req, res) => {
  try {
    const summary = await bookingService.getCustomerAttendanceSummary(req.userId);
    res.json({ data: summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getVisitedGyms = async (req, res) => {
  try {
    const visitedGyms = await bookingService.getVisitedGyms(req.userId);
    res.json({ data: visitedGyms });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getCancellationPolicy = async (req, res) => {
  try {
    const policy = await bookingService.getCancellationPolicy();
    res.json({ data: policy });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateCancellationPolicy = async (req, res) => {
  try {
    const { tiers } = req.body || {};
    const policy = await bookingService.updateCancellationPolicy(tiers, req.userId);
    res.json({ data: policy });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getSlotCounts = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const { date } = req.query;
    const counts = await bookingService.getSlotCounts(gymId, date);
    res.json({ data: counts });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal service-to-service: gym-service computes class-occurrence
// availability across upcoming dates (?dates=2026-08-10,2026-08-17,...).
export const getClassCounts = async (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const dates = String(req.query.dates || '').split(',').map(d => d.trim()).filter(Boolean);
    const counts = await bookingService.getClassCounts(classId, dates);
    res.json({ data: counts });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getBookingCountForGym = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const count = await bookingService.getBookingCountForGym(gymId);
    res.json({ data: { count } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getCompletedVisitCountForSubscription = async (req, res) => {
  try {
    const subscriptionId = parseInt(req.params.id);
    const count = await bookingService.getCompletedVisitCountForSubscription(subscriptionId);
    res.json({ data: { count } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getCustomerIdsWithCompletedBooking = async (req, res) => {
  try {
    const customerIds = Array.isArray(req.body?.customerIds)
      ? req.body.customerIds.map(Number).filter(Number.isFinite)
      : [];
    if (!customerIds.length) return res.json({ data: [] });
    const active = await bookingService.getCustomerIdsWithCompletedBooking(customerIds);
    res.json({ data: active });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getLastVisitDateForSubscription = async (req, res) => {
  try {
    const subscriptionId = parseInt(req.params.id);
    const lastVisitDate = await bookingService.getLastVisitDateForSubscription(subscriptionId);
    res.json({ data: { lastVisitDate } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymBookings = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const bookings = await bookingService.getGymBookings(gymId, req.userId);
    res.json({ data: bookings });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymSalesSummary = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const summary = await bookingService.getGymSalesSummary(gymId, req.userId);
    res.json({ data: summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymAttendanceSummary = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const summary = await bookingService.getGymAttendanceSummary(gymId, req.userId);
    res.json({ data: summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getAdminAttendanceSummary = async (req, res) => {
  try {
    const gymId = req.query.gymId ? parseInt(req.query.gymId) : undefined;
    const summary = await bookingService.getAdminAttendanceSummary(gymId);
    res.json({ data: summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getAdminAttendanceByGym = async (req, res) => {
  try {
    const rows = await bookingService.getAdminAttendanceByGym(req.query.period);
    res.json({ data: rows });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Admin (gobhi) bookings/presence explorer for one gym — no bookings list
// existed in admin at all before this; mirrors getGymBookings' partner
// version (name+photo, no phone), just without the ownership check.
export const getGymBookingsAdmin = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const bookings = await bookingService.getGymBookingsAdmin(gymId);
    res.json({ data: bookings });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymLiveOccupancy = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getGymLiveOccupancy(gymId, req.userId);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getAdminLiveOccupancy = async (req, res) => {
  try {
    const gymId = req.query.gymId ? parseInt(req.query.gymId) : undefined;
    const result = await bookingService.getAdminLiveOccupancy(gymId);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymAttendanceHeatmap = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getGymAttendanceHeatmap(gymId, req.userId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getAdminAttendanceHeatmap = async (req, res) => {
  try {
    const gymId = req.query.gymId ? parseInt(req.query.gymId) : undefined;
    const result = await bookingService.getAdminAttendanceHeatmap(gymId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMemberActivityForGym = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getMemberActivityForGym(gymId, req.userId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMemberActivityAdmin = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getMemberActivityAdmin(gymId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Trainer attendance + training-session linking (role='trainer') --------

export const trainerCheckIn = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const { lat, lng } = req.body ?? {};
    const result = await bookingService.trainerCheckIn(req.userId, gymId, Number(lat), Number(lng));
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMyTrainerAttendance = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getMyTrainerAttendance(req.userId, gymId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getTodaysTrainableBookings = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getTodaysTrainableBookings(gymId);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const logTrainingSession = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const bookingId = parseInt(req.body?.bookingId);
    const result = await bookingService.logTrainingSession(req.userId, gymId, bookingId);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMyTrainingSessions = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getMyTrainingSessions(req.userId, gymId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getTrainersOverviewForGym = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getTrainersOverviewForGym(gymId, req.userId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getTrainersOverviewAdmin = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getTrainersOverviewAdmin(gymId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getTrainerSessionsForPartner = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const trainerId = parseInt(req.params.trainerId);
    const result = await bookingService.getTrainerSessionsForPartner(trainerId, gymId, req.userId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getTrainerSessionsAdmin = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const trainerId = parseInt(req.params.trainerId);
    const result = await bookingService.getTrainerSessionsAdmin(trainerId, gymId, req.query.days);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getTopPerformingGyms = async (req, res) => {
  try {
    const result = await bookingService.getTopPerformingGyms(req.query.days, req.query.limit);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getPublicAttendanceStats = async (req, res) => {
  try {
    const stats = await bookingService.getPublicAttendanceStats();
    res.json({ data: stats });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

const CANCELLATION_REASONS = ['not_this_time', 'injury', 'work', 'travel', 'other'];
const NEXT_VISIT_INTENTS = ['today', 'this_week', 'this_month', 'unsure'];

export const cancelBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    // FR-14 — both optional. An invalid value is rejected rather than
    // silently dropped, since a client sending garbage here is a bug worth
    // surfacing; omitting them entirely is the normal "skipped" path.
    const { cancellationReason, nextVisitIntent } = req.body || {};
    if (cancellationReason !== undefined && cancellationReason !== null
        && !CANCELLATION_REASONS.includes(cancellationReason)) {
      return res.status(400).json({ error: `cancellationReason must be one of: ${CANCELLATION_REASONS.join(', ')}` });
    }
    if (nextVisitIntent !== undefined && nextVisitIntent !== null
        && !NEXT_VISIT_INTENTS.includes(nextVisitIntent)) {
      return res.status(400).json({ error: `nextVisitIntent must be one of: ${NEXT_VISIT_INTENTS.join(', ')}` });
    }
    const booking = await bookingService.cancelBooking(bookingId, req.userId, {
      cancellationReason,
      nextVisitIntent,
    });
    res.json({ data: booking });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const requestCheckIn = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const { lat, lng } = req.body;
    const result = await bookingService.requestCheckIn(bookingId, req.userId, lat, lng);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const completeBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const gymId = parseInt(req.query.gymId || req.body.gymId);
    if (isNaN(gymId)) return res.status(400).json({ error: 'gymId is required' });
    const { override, overrideReason } = req.body || {};
    const booking = await bookingService.completeBooking(bookingId, gymId, req.userId, {
      override: !!override,
      overrideReason,
    });
    res.json({ data: booking });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const verifyAttendance = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const gymId = parseInt(req.body.gymId);
    if (isNaN(gymId)) return res.status(400).json({ error: 'gymId is required' });
    const { qrToken, confirmSlotShift } = req.body;
    const result = await bookingService.verifyAttendance(bookingId, gymId, req.userId, { qrToken, confirmSlotShift: !!confirmSlotShift });
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error', code: err.code, confirmation: err.confirmation });
  }
};

export const getMyAttendanceWarnings = async (req, res) => {
  try {
    const result = await bookingService.getMyAttendanceWarnings(req.userId);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const selfCheckIn = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const { lat, lng, confirmEarly } = req.body;
    const result = await bookingService.selfCheckIn(gymId, req.userId, lat, lng, !!confirmEarly);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
      confirmation: err.confirmation,
    });
  }
};

export const confirmBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const gymId = parseInt(req.query.gymId || req.body.gymId);
    if (isNaN(gymId)) return res.status(400).json({ error: 'gymId is required' });
    const booking = await bookingService.confirmBooking(bookingId, gymId, req.userId);
    res.json({ data: booking });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ─── Attendance-SaaS: booking-free member check-in ────────────────────
export const memberCheckIn = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const { lat, lng } = req.body;
    const result = await bookingService.memberCheckIn(gymId, req.userId, lat, lng);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
};

export const getMemberAttendance = async (req, res) => {
  try {
    const records = await bookingService.getMemberAttendance(req.userId);
    res.json({ data: records });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymLeaderboard = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const result = await bookingService.getGymLeaderboard(gymId, req.query.window, req.userId);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};


// ---- DPDPA access right (s.11) -------------------------------------------
// Internal only: auth-service authenticates the user and fans out to every
// service that holds their data, then assembles one document. Never exposed
// at the gateway, so there is no path where a userId in a URL could let one
// person read another's slice.
export const exportUserInternal = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A numeric userId is required' });
    }
    const data = await exportService.buildExportService(userId);
    res.json({ data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
