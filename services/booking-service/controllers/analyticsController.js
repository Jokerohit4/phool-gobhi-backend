import * as analyticsQuery from '../services/analyticsQueryService.js';
import * as savedFunnels from '../services/savedFunnelService.js';

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

export const getBadgeSummary = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getBadgeSummary(req.query.days) });
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

export const getWebsiteTraffic = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getWebsiteTraffic(req.query.days) });
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

export const getLocationReach = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getLocationReach(req.query.days, req.query.limit) });
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

export const getKnownEvents = async (req, res) => {
  try {
    res.json({ data: await analyticsQuery.getKnownEvents(req.query.limit) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getKnownPropertyKeys = async (req, res) => {
  try {
    if (!req.query.event) return res.status(400).json({ error: 'event is required' });
    res.json({ data: await analyticsQuery.getKnownPropertyKeys(req.query.event, req.query.limit) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const getKnownPropertyValues = async (req, res) => {
  try {
    const { event, key, limit } = req.query;
    if (!event || !key) return res.status(400).json({ error: 'event and key are required' });
    res.json({ data: await analyticsQuery.getKnownPropertyValues(event, key, limit) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const searchEventUsers = async (req, res) => {
  try {
    const { event, filters, days, limit } = req.query;
    if (!event) return res.status(400).json({ error: 'event is required' });
    let parsedFilters = {};
    if (filters) {
      try {
        parsedFilters = JSON.parse(filters);
      } catch {
        return res.status(400).json({ error: 'filters must be JSON, e.g. {"city":"Gurugram"}' });
      }
    }
    res.json({ data: await analyticsQuery.searchEventUsers(event, parsedFilters, days, limit) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Runs either a saved funnel (funnelId) or an ad-hoc one (steps, as a JSON
// query param) — same validateSteps gate as saving one, so an unsaved
// preview can't reach the query builder with anything saving wouldn't allow.
export const getCustomFunnelResult = async (req, res) => {
  try {
    const { funnelId, steps, days } = req.query;
    let rawSteps;
    if (funnelId) {
      const saved = await savedFunnels.getSavedFunnel(funnelId);
      if (!saved) return res.status(404).json({ error: `No saved funnel with id ${funnelId}` });
      rawSteps = saved.steps;
    } else if (steps) {
      try {
        rawSteps = JSON.parse(steps);
      } catch {
        return res.status(400).json({ error: 'steps must be JSON, e.g. [{"event":"gym_viewed"},{"event":"book_tapped"}]' });
      }
    } else {
      return res.status(400).json({ error: 'Provide either funnelId or steps' });
    }
    const validSteps = savedFunnels.validateSteps(rawSteps);
    res.json({ data: await analyticsQuery.getCustomFunnel(validSteps, days) });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

export const listSavedFunnels = async (req, res) => {
  try {
    res.json({ data: await savedFunnels.listSavedFunnels() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const createSavedFunnel = async (req, res) => {
  try {
    const { name, steps } = req.body;
    const created = await savedFunnels.createSavedFunnel(name, steps, req.userId ?? null);
    res.status(201).json({ data: created });
  } catch (err) {
    const status = /required|between 2 and 8|missing an event/.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message || 'Server error' });
  }
};

export const deleteSavedFunnel = async (req, res) => {
  try {
    await savedFunnels.deleteSavedFunnel(req.params.id);
    res.status(204).end();
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
