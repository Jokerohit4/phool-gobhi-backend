import * as runService from '../services/runService.js';
import { serializeDecimals } from '../utils/serializeDecimals.js';

export const createRun = async (req, res) => {
  try {
    // NOTE: run-tracker-spec.html §13 calls for server-side run_saved_server
    // / run_distance_mismatch events, but health-service (unlike
    // gym/booking/wallet/auth/buddy-service) has no utils/analytics.js sink
    // at all yet — that's a pre-existing platform gap, not something to
    // wire up as a side effect of this endpoint. `mismatch` is still
    // computed and the server-side distance still wins; it's just not
    // logged anywhere until health-service gets an analytics sink of its
    // own, matching the other services' utils/analytics.js.
    const { record } = await runService.createRunService(req.userId, req.body);
    res.status(201).json({ data: serializeDecimals(record) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listRuns = async (req, res) => {
  try {
    const { runs, nextCursor } = await runService.listRunsService(req.userId, req.query);
    res.json({ data: serializeDecimals(runs), nextCursor });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getRunSummary = async (req, res) => {
  try {
    const summary = await runService.getRunSummaryService(req.userId, req.query);
    res.json({ data: serializeDecimals(summary) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getRunDetail = async (req, res) => {
  try {
    const record = await runService.getRunDetailService(req.userId, req.params.id);
    res.json({ data: serializeDecimals(record) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deleteRun = async (req, res) => {
  try {
    await runService.deleteRunService(req.userId, req.params.id);
    res.json({ data: { deleted: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
