import * as activityService from '../services/activityService.js';
import { serializeDecimals } from '../utils/serializeDecimals.js';

export const createExerciseRecord = async (req, res) => {
  try {
    const record = await activityService.createExerciseRecordService(req.userId, req.body);
    res.status(201).json({ data: serializeDecimals(record) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listExerciseRecords = async (req, res) => {
  try {
    const records = await activityService.listExerciseRecordsService(req.userId, req.query);
    res.json({ data: serializeDecimals(records) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const syncDailyActivity = async (req, res) => {
  try {
    const { rows } = req.body || {};
    const synced = await activityService.syncDailyActivityService(req.userId, rows);
    res.json({ data: serializeDecimals(synced) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getDailyActivity = async (req, res) => {
  try {
    const activity = await activityService.getDailyActivityService(req.userId, req.query);
    res.json({ data: serializeDecimals(activity) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal twin of getDailyActivity for booking-service's leaderboard score —
// reads rows for a batch of user ids (never req.userId). `ids` is a
// comma-separated list; bounded so a runaway caller can't do one giant `IN`.
export const getDailyActivityInternal = async (req, res) => {
  try {
    const ids = String(req.query?.ids ?? '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'ids is required (comma-separated user ids)' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'ids must contain at most 500 user ids' });
    }
    const activity = await activityService.getDailyActivityForUsersService(ids, req.query);
    res.json({ data: serializeDecimals(activity) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
