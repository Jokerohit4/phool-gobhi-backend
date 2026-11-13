import * as planService from '../services/planService.js';
import { serializeDecimals } from '../utils/serializeDecimals.js';

export const listPlans = async (req, res) => {
  try {
    const plans = await planService.listPlansService();
    res.json({ data: plans });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getActivePlan = async (req, res) => {
  try {
    const active = await planService.getActivePlanService(req.userId);
    res.json({ data: active ? serializeDecimals(active) : null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const startPlan = async (req, res) => {
  try {
    const active = await planService.startPlanService(req.userId, req.params.key);
    res.json({ data: serializeDecimals(active) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const abandonPlan = async (req, res) => {
  try {
    await planService.abandonPlanService(req.userId);
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
