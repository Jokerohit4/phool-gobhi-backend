import * as analyticsQuery from '../services/analyticsQueryService.js';

// Thin wrappers, same shape as the existing admin attendance endpoints in
// bookingController.js — every route here is requireRole('gobhi') (see
// routes/booking.js) and backs the admin portal's /analytics page.

export const getOnboardingFunnel = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getOnboardingFunnel(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getApprovalSla = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getApprovalSla(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getConversionFunnel = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getConversionFunnel(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getFulfillmentFunnel = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getFulfillmentFunnel(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getActivation = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getActivation(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getWalletFunnel = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getWalletFunnel(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getBuddyFunnel = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getBuddyFunnel(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getTrend = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getTrend(req.query.metric, req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
