import axios from 'axios';
import { identityLabel } from './reportReadings.js';
import { BIOMETRIC_KEYS, canonicalValue, valuesFromReadings } from './readingMetrics.js';

// Optional second reader for lab reports the layout parser could not follow.
//
// What it is for: the deterministic reader (reportReadings.js) is exact on the
// layouts it understands and silent on the rest. A language model is the
// opposite, which is why it is used as a fallback and never as the source of
// truth:
//
//   1. It runs only when the deterministic result looks thin next to what the
//      text suggests is there (needsModel). Ordinary reports never reach it, so
//      the common case costs nothing.
//   2. It is sent redacted table-like lines only. No patient name, address,
//      phone, email, ID, doctor or any line carrying them, no narrative, no
//      user id. The request describes a table, never a person.
//   3. Nothing it returns is trusted: every row must be grounded in the text it
//      was sent (the value appears on the label's own line or the next two),
//      or it is dropped. A model that invents or swaps a number produces a row
//      that cannot be found in the report, and so never reaches the person.
//   4. It only ADDS rows the deterministic reader did not find. It cannot
//      overwrite or remove one.
//   5. Off unless REPORT_LLM_ENABLED=true, with a per-instance daily call cap,
//      and any failure returns the deterministic result untouched. The
//      provider's error body is never logged: provider errors echo the request.
//
// It reuses the assistant's gateway credentials (ASSISTANT_PROVIDER_*), so no
// new secret exists to rotate. REPORT_LLM_MODEL overrides the model only.

const MAX_INPUT_CHARS = 12000;
const MAX_ROWS = 500;
const TIMEOUT_MS = 25000;
const LIMITS = { label: 160, value: 120, unit: 48, referenceRange: 120, flag: 40 };

const QUALITATIVE = /\b(?:negative|positive|nil|absent|present|reactive|non[\s-]?reactive|trace|detected|not\s+detected|normal|clear)\b/i;
const EMAIL = /\S+@\S+\.\S+/;
const LONG_DIGITS = /\d{8,}/; // phone numbers, barcodes, accession and lab ids; never a result
const LABELED_NUMBER = /^[A-Za-z][A-Za-z0-9 .()/%,&-]{2,70}?\s+[<>≤≥]?\s*\d+(?:\.\d+)?(?:\s|$)/;
const LABEL_ONLY = /^[A-Za-z][A-Za-z .()/&,-]{2,70}$/;
const NUMBER_ONLY = /^[<>≤≥]?\s*\d+(?:\.\d+)?$/;
const ALLOWED_FLAG = /^(?:h|l|hh|ll|high|low|abnormal|critical|normal|n|↑|↓)$/i;

const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const squash = text => String(text ?? '').toLowerCase().replace(/[\s,]/g, '');
const cleanLines = text => String(text || '').split(/\r?\n/).map(clean).filter(Boolean);

export function modelConfig(env = process.env) {
  if (String(env.REPORT_LLM_ENABLED || '').trim() !== 'true') return null;
  const baseUrl = String(env.ASSISTANT_PROVIDER_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(env.ASSISTANT_PROVIDER_API_KEY || '').trim();
  const model = String(env.REPORT_LLM_MODEL || env.ASSISTANT_PROVIDER_MODEL || '').trim();
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : null;
}

// Roughly how many result rows the text seems to contain, counting both
// "Label 13.5 g/dL" on one line and the value-on-its-own-line shape that form
// parsers emit for tables.
export function countResultCandidates(text) {
  const lines = cleanLines(text);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (LABELED_NUMBER.test(lines[i]) && !identityLabel.test(lines[i])) count++;
    else if (i > 0 && NUMBER_ONLY.test(lines[i]) && LABEL_ONLY.test(lines[i - 1]) && !identityLabel.test(lines[i - 1])) count++;
  }
  return count;
}

// The deterministic reader found well under what the text suggests is there.
export function needsModel({ readings = [], text = '' }) {
  if (String(text).length < 200) return false;
  const candidates = countResultCandidates(text);
  return candidates >= 3 && readings.length < Math.ceil(candidates * 0.6);
}

// What may leave the building: table-like lines, minus anything that names the
// patient. Order is preserved because a label and its value can sit on
// adjacent lines.
export function redactForModel(text, profile = {}) {
  const secrets = [profile?.name, profile?.address]
    .filter(value => typeof value === 'string' && value.trim().length >= 3)
    .map(value => value.trim().toLowerCase());
  const kept = [];
  let size = 0;
  for (const line of cleanLines(text)) {
    if (line.length > 140) continue; // narrative paragraph, not a table row
    if (identityLabel.test(line) || EMAIL.test(line) || LONG_DIGITS.test(line)) continue;
    const lower = line.toLowerCase();
    if (secrets.some(secret => lower.includes(secret))) continue;
    if (!/\d/.test(line) && !QUALITATIVE.test(line) && !LABEL_ONLY.test(line)) continue;
    if (size + line.length + 1 > MAX_INPUT_CHARS) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join('\n');
}

const SYSTEM = 'You convert laboratory report text into JSON rows. Reply with JSON only. Copy text exactly as printed and never invent, correct, convert or infer a value.';
const instruction = input => [
  'Extract every laboratory test result from the text below.',
  'Reply with {"rows":[{"label":"","value":"","unit":"","referenceRange":"","flag":""}]}.',
  'Rules: copy label, value, unit and referenceRange exactly as printed. Use "" for anything not printed.',
  'flag is H, L, High, Low, Abnormal or Critical only when the report prints it.',
  'Skip dates, addresses, names, method names and narrative notes. A label and its value may be on neighbouring lines.',
  '',
  input,
].join('\n');

export function parseModelRows(content) {
  const raw = String(content || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const rows = JSON.parse(raw.slice(start, end + 1))?.rows;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "7,200" and "7200" are the same result; spacing is not meaningful.
const plain = text => String(text).toLowerCase().replace(/(\d),(?=\d)/g, '$1').replace(/\s+/g, ' ');
// A whole token, not a substring: "g/dL" is not in "mg/dL", "5" is not in "5.1",
// and a flag "H" is not any letter h in a word.
function hasToken(haystack, needle) {
  const text = plain(needle).trim();
  if (!text) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}/.])${escapeRe(text)}(?![\\p{L}\\p{N}]|\\.\\d)`, 'u').test(haystack);
}
const RESULT_WORD = /\d|negative|positive|nil|absent|present|reactive|detected|trace/i;

// Keeps a row only when it can be found in what was sent. The label's first real
// word must be on a line, and the value must be on that same line after the
// label or, when the label sits alone on its line, on the next two (form parsers
// emit tables cell by cell). Optional fields must come from the same place. A
// short value like "5" is weak evidence anywhere in a page and strong evidence
// beside its own label, which is why the check is local and token-exact.
export function groundRows(rows, sourceText) {
  const lines = cleanLines(sourceText);
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (out.length >= MAX_ROWS) break;
    if (!row || typeof row !== 'object') continue;
    const field = key => (typeof row[key] === 'string' || typeof row[key] === 'number' ? clean(row[key]) : '');
    const label = field('label');
    const value = field('value');
    if (!label || !value || label.length > LIMITS.label || value.length > LIMITS.value) continue;
    if (identityLabel.test(label) || !/\p{L}/u.test(label)) continue;
    const head = plain((label.split(/\s+/).find(word => word.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    if (head.length < 3) continue;

    let area = null;
    for (let i = 0; i < lines.length && area === null; i++) {
      const line = plain(lines[i]);
      const at = line.indexOf(head);
      if (at < 0) continue;
      const after = line.slice(at + head.length);
      let local = after;
      if (!RESULT_WORD.test(after)) {
        // Label alone on its line: its cells follow, up to the next labelled row.
        for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
          if (LABELED_NUMBER.test(lines[j])) break;
          local += ` ${plain(lines[j])}`;
        }
      }
      if (hasToken(local, value)) area = local;
    }
    if (area === null) continue;

    const reading = { label, value };
    for (const key of ['unit', 'referenceRange', 'flag']) {
      const text = field(key);
      if (!text || text.length > LIMITS[key]) continue;
      if (key === 'flag' && !ALLOWED_FLAG.test(text)) continue;
      if (hasToken(area, text)) reading[key] = text;
    }
    const id = `${squash(label)}|${squash(value)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(reading);
  }
  return out;
}

// Deterministic rows win and keep their order; a model row is added only when
// no existing row already carries the same value under the same first word.
export function mergeReadings(base = [], extra = []) {
  const firstWord = label => squash(clean(label).split(/\s+/)[0] || '');
  const known = new Set(base.map(row => `${firstWord(row.label)}|${squash(row.value)}`));
  const merged = [...base];
  for (const row of extra) {
    const id = `${firstWord(row.label)}|${squash(row.value)}`;
    if (known.has(id)) continue;
    known.add(id);
    merged.push(row);
  }
  return merged.slice(0, MAX_ROWS);
}

// A per-instance cap, so a bad day cannot turn into an unbounded bill. Instances
// do not share it, which makes it an approximate ceiling, not an exact quota.
const budget = { day: '', used: 0 };
function takeBudget(env) {
  const cap = Number.parseInt(env.REPORT_LLM_DAILY_CAP ?? '300', 10);
  const limit = Number.isFinite(cap) && cap >= 0 ? cap : 300;
  const day = new Date().toISOString().slice(0, 10);
  if (budget.day !== day) { budget.day = day; budget.used = 0; }
  if (budget.used >= limit) return false;
  budget.used++;
  return true;
}
export function resetBudgetForTests() { budget.day = ''; budget.used = 0; }

export async function structureWithModel(text, profile, { post = axios.post, env = process.env } = {}) {
  const config = modelConfig(env);
  if (!config) return [];
  const input = redactForModel(text, profile);
  if (input.length < 80 || !takeBudget(env)) return [];
  try {
    const res = await post(`${config.baseUrl}/chat/completions`, {
      model: config.model,
      temperature: 0,
      max_tokens: 4000,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: instruction(input) }],
    }, { timeout: TIMEOUT_MS, headers: { Authorization: `Bearer ${config.apiKey}` } });
    return groundRows(parseModelRows(res?.data?.choices?.[0]?.message?.content), input);
  } catch {
    return []; // never log: the provider's error body can echo the request
  }
}

const RAW_LIMIT = 200;
const STORED_UNITS = { hba1c: '%', hdl: 'mg/dL', ldl: 'mg/dL', triglycerides: 'mg/dL' };

// Any layout that yielded a readable row gives a biometric, not just the ones
// the entity extractor happened to hit. Confidence 0 means "read off the page",
// which the app shows as no match score.
export function fillFromReadings(parsed) {
  const have = new Set((parsed.extractions || []).map(ex => ex.metric));
  const extractions = [...(parsed.extractions || [])];
  const values = valuesFromReadings(parsed.readings, BIOMETRIC_KEYS);
  for (const metric of BIOMETRIC_KEYS) {
    if (have.has(metric) || values[metric] == null) continue;
    const source = (parsed.readings || []).find(row => canonicalValue(metric, row.value, row.unit) === values[metric]);
    extractions.push({
      metric,
      rawValue: clean(`${source?.label || metric} ${source?.value || ''} ${source?.unit || ''}`).slice(0, RAW_LIMIT),
      normalizedValue: values[metric],
      unit: STORED_UNITS[metric],
      confidence: 0,
    });
  }
  const markers = { ...(parsed.markers || {}) };
  const liver = valuesFromReadings(parsed.readings, ['sgot', 'sgpt']);
  for (const key of Object.keys(liver)) if (markers[key] == null) markers[key] = liver[key];
  return { ...parsed, extractions, markers };
}

export async function enrichParsedReport(parsed, text, options) {
  let next = parsed;
  if (modelConfig(options?.env) && needsModel({ readings: parsed.readings, text })) {
    const rows = await structureWithModel(text, parsed.profile, options);
    if (rows.length) next = { ...next, readings: mergeReadings(next.readings, rows) };
  }
  return fillFromReadings(next);
}
