import * as measurementService from '../services/measurementService.js';
import { serializeDecimals } from '../utils/serializeDecimals.js';

// Sanity bounds, not medical judgement — these exist to reject typos and
// unit mix-ups (a weight in pounds, a body-fat figure entered as 0.18)
// before they poison the chart's y-axis, per the BRD's "honest, not
// prescriptive" line: no warnings about the value itself, just a 400 when
// it can't be a real human measurement.
const WEIGHT_MIN_KG = 20;
const WEIGHT_MAX_KG = 400;
const BODY_FAT_MIN_PCT = 2;
const BODY_FAT_MAX_PCT = 70;

export const upsertMeasurement = async (req, res) => {
  try {
    const { localDate, weightKg, bodyFatPct } = req.body || {};
    if (weightKg === undefined && bodyFatPct === undefined) {
      return res.status(400).json({ error: 'One of weightKg or bodyFatPct is required' });
    }
    if (weightKg !== undefined && weightKg !== null) {
      const w = Number(weightKg);
      if (!Number.isFinite(w) || w < WEIGHT_MIN_KG || w > WEIGHT_MAX_KG) {
        return res.status(400).json({ error: `weightKg must be between ${WEIGHT_MIN_KG} and ${WEIGHT_MAX_KG}` });
      }
    }
    if (bodyFatPct !== undefined && bodyFatPct !== null) {
      const f = Number(bodyFatPct);
      if (!Number.isFinite(f) || f < BODY_FAT_MIN_PCT || f > BODY_FAT_MAX_PCT) {
        return res.status(400).json({ error: `bodyFatPct must be between ${BODY_FAT_MIN_PCT} and ${BODY_FAT_MAX_PCT}` });
      }
    }
    if (localDate !== undefined && localDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      return res.status(400).json({ error: 'localDate must be YYYY-MM-DD' });
    }
    const measurement = await measurementService.upsertMeasurementService(req.userId, {
      localDate,
      weightKg,
      bodyFatPct,
    });
    res.status(201).json({ data: serializeDecimals(measurement) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listMeasurements = async (req, res) => {
  try {
    const measurements = await measurementService.listMeasurementsService(req.userId, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ data: serializeDecimals(measurements) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deleteMeasurement = async (req, res) => {
  try {
    await measurementService.deleteMeasurementService(req.userId, req.params.localDate);
    res.json({ data: { deleted: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
