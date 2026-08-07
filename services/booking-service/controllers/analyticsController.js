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

export const getRetentionCohorts = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getRetentionCohorts(req.query.weeks) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getCityBreakdown = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getCityBreakdown(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getRevenueTrend = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getRevenueTrend(req.query.days) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getSupplyHealth = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getSupplyHealth() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getRecentAnonSessions = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getRecentAnonSessions(req.query.days, req.query.limit) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getUserJourney = async (req, res) => {
  try {
    const { distinctId: rawDistinctId, days } = req.query;
    if (!rawDistinctId) return res.status(400).json({ error: 'distinctId is required' });

    // rawDistinctId may be a phone number typed into the search box — resolve
    // it to the real distinct_id first; a phone-shaped input that matches no
    // account is a clean 404, not an empty journey for the raw phone string.
    const distinctId = await analyticsQuery.resolveDistinctIdFromSearch(rawDistinctId);
    if (!distinctId) return res.status(404).json({ error: `No user found for "${rawDistinctId}"` });

    const [journey, profile] = await Promise.all([
      analyticsQuery.getUserJourney(distinctId, days),
      analyticsQuery.getUserProfile(distinctId),
    ]);
    res.json({ data: { ...journey, profile } });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
