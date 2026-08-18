import * as bookingService from '../services/bookingService.js';

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

export const getPublicAttendanceStats = async (req, res) => {
  try {
    const stats = await bookingService.getPublicAttendanceStats();
    res.json({ data: stats });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const cancelBooking = async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const booking = await bookingService.cancelBooking(bookingId, req.userId);
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
