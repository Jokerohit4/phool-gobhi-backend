import * as bookingService from '../services/bookingService.js';

export const createBooking = async (req, res) => {
  try {
    const { gymId, date, startTime, endTime } = req.body;
    const booking = await bookingService.createBooking(req.userId, { gymId, date, startTime, endTime });
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
    const booking = await bookingService.completeBooking(bookingId, gymId, req.userId);
    res.json({ data: booking });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
