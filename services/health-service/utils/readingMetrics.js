import { GUIDANCE_BOUNDS } from './guidanceExtraction.js';

// Maps a printed lab row (label, value, unit) onto the handful of values the
// platform actually computes with. Kept free of database and service imports so
// the report pipeline, the confirm route and tests can all use it without
// mocking anything.
//
// The readings list is the one place a person reviews what the report said, so
// it is the source of truth: these helpers read the confirmed list and derive
// the typed values from it, rather than asking the person to type the same
// number into a second form.

const PATTERNS = [
  ['hba1c', /\b(?:hb\s*a1c|a1c|glyc(?:at|osylat)ed\s+ha?emoglobin|ha?emoglobin\s+a1c)\b/i],
  ['hdl', /\b(?:hdl|high[\s-]density\s+lipoprotein)\b/i],
  ['ldl', /\b(?:ldl|low[\s-]density\s+lipoprotein)\b/i],
  ['triglycerides', /\btriglycerides?\b/i],
  ['sgot', /\b(?:sgot|ast|aspartate\s+(?:amino)?transferase)\b/i],
  ['sgpt', /\b(?:sgpt|alt|alanine\s+(?:amino)?transferase)\b/i],
];

// Rows that name a marker without being its value: "LDL/HDL ratio" is not an
// LDL, non-HDL cholesterol is not an HDL, and VLDL is a different test.
const EXCLUDED = /\bratio\b|\bnon[\s-]?hdl\b|\bvldl\b/i;

// Mirrors biometricService.METRIC_BOUNDS for the metrics a report can feed. Kept
// here as a copy because importing that module drags the database client into
// every caller; test/readingMetrics.test.js fails if the two ever drift.
export const BIOMETRIC_BOUNDS = Object.freeze({ hba1c: [3, 20], ldl: [20, 400], hdl: [10, 200], triglycerides: [10, 1000] });

export const BIOMETRIC_KEYS = Object.freeze(['hba1c', 'hdl', 'ldl', 'triglycerides']);
export const MARKER_KEYS = Object.freeze(['hba1c', 'triglycerides', 'sgot', 'sgpt']);

export function metricForLabel(label) {
  const text = String(label || '');
  if (!text || EXCLUDED.test(text)) return null;
  for (const [key, pattern] of PATTERNS) {
    if (pattern.test(text)) return key;
  }
  return null;
}

const unitKey = unit => String(unit || '').toLowerCase().replace(/\s+/g, '');

/**
 * The value in the unit the platform stores, or null when the printed value
 * cannot be used: a comparator ("<5"), a unit we cannot convert, or a number
 * outside the sanity bounds (which is what a misread or unit mix-up looks like).
 * An empty unit is taken as already canonical; the bounds are what catch it
 * when it was not.
 */
export function canonicalValue(key, value, unit = '') {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const number = Number(raw);
  const u = unitKey(unit);
  let out = number;
  if (key === 'hba1c') {
    if (u === 'mmol/mol') out = 0.09148 * number + 2.152; // IFCC -> NGSP
    else if (u && u !== '%') return null;
  } else if (key === 'hdl' || key === 'ldl') {
    if (u === 'mmol/l') out = number * 38.67;
    else if (u && u !== 'mg/dl') return null;
  } else if (key === 'triglycerides') {
    if (u === 'mmol/l') out = number * 88.57;
    else if (u && u !== 'mg/dl') return null;
  } else if (key === 'sgot' || key === 'sgpt') {
    if (u && u !== 'u/l' && u !== 'iu/l') return null;
  } else {
    return null;
  }
  const [min, max] = BIOMETRIC_BOUNDS[key] || GUIDANCE_BOUNDS[key] || [0, Infinity];
  const bounded = GUIDANCE_BOUNDS[key];
  if (out < min || out > max) return null;
  if (bounded && (out < bounded[0] || out > bounded[1])) return null;
  return Math.round(out * 100) / 100;
}

/**
 * One value per marker, first usable row wins (a panel prints each marker once;
 * a second hit is a summary table or a repeat). Returns { key: number }.
 */
export function valuesFromReadings(readings, keys = [...BIOMETRIC_KEYS, ...MARKER_KEYS]) {
  const wanted = new Set(keys);
  const out = {};
  for (const reading of Array.isArray(readings) ? readings : []) {
    const key = metricForLabel(reading?.label);
    if (!key || !wanted.has(key) || key in out) continue;
    const value = canonicalValue(key, reading.value, reading.unit);
    if (value !== null) out[key] = value;
  }
  return out;
}
