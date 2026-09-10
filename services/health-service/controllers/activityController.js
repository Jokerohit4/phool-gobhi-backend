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
