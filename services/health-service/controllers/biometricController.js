import * as biometricService from '../services/biometricService.js';
import { serializeDecimals } from '../utils/serializeDecimals.js';

const METRICS = Object.keys(biometricService.METRIC_UNITS);
const SOURCES = ['manual', 'healthkit', 'health_connect'];

function badDate(value) {
  return value !== undefined && value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Accepts either a single {metric, value} or {entries: [...]} — the Fitness+
// "Track body" flow sends one, the Health+ "Add today's numbers" quick-add
// sends several in one round trip.
export const upsertEntries = async (req, res) => {
  try {
    const { metric, value, localDate, source, entries } = req.body || {};
    if (badDate(localDate)) return res.status(400).json({ error: 'localDate must be YYYY-MM-DD' });
    if (source !== undefined && !SOURCES.includes(source)) {
      return res.status(400).json({ error: `source must be one of: ${SOURCES.join(', ')}` });
    }

    const list = Array.isArray(entries) && entries.length > 0
      ? entries
      : (metric !== undefined ? [{ metric, value, localDate, source }] : []);
    if (list.length === 0) {
      return res.status(400).json({ error: 'Provide a metric + value, or a non-empty entries array' });
    }

    for (const entry of list) {
      if (!METRICS.includes(entry.metric)) {
        return res.status(400).json({ error: `metric must be one of: ${METRICS.join(', ')}` });
      }
      if (badDate(entry.localDate)) {
        return res.status(400).json({ error: 'localDate must be YYYY-MM-DD' });
      }
      if (entry.source !== undefined && !SOURCES.includes(entry.source)) {
        return res.status(400).json({ error: `source must be one of: ${SOURCES.join(', ')}` });
      }
      const problem = biometricService.validateMetricValue(entry.metric, entry.value);
      if (problem) return res.status(400).json({ error: problem });
    }

    const saved = await biometricService.upsertManyService(req.userId, list, { localDate, source });
    res.status(201).json({ data: serializeDecimals(saved) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listEntries = async (req, res) => {
  try {
    const { metric, from, to } = req.query || {};
    if (metric !== undefined && !METRICS.includes(metric)) {
      return res.status(400).json({ error: `metric must be one of: ${METRICS.join(', ')}` });
    }
    if (badDate(from) || badDate(to)) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    }
    const entries = await biometricService.listEntriesService(req.userId, { metric, from, to });
    res.json({ data: serializeDecimals(entries) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getLatest = async (req, res) => {
  try {
    const latest = await biometricService.latestByMetricService(req.userId);
    res.json({ data: serializeDecimals(latest) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deleteEntry = async (req, res) => {
  try {
    const { metric, localDate } = req.params;
    if (!METRICS.includes(metric)) {
      return res.status(400).json({ error: `metric must be one of: ${METRICS.join(', ')}` });
    }
    if (badDate(localDate)) return res.status(400).json({ error: 'localDate must be YYYY-MM-DD' });
    await biometricService.deleteEntryService(req.userId, metric, localDate);
    res.json({ data: { deleted: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
