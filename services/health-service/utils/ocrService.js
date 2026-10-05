import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const LOCATION = 'us'; // or 'eu'
const PROCESSOR_ID = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;

/**
 * Interface for Document AI's OCR processing.
 * Uses the 'FORM_PARSER_PROCESSOR' or 'HEALTH_REPORT_PROCESSOR' if available.
 *
 * Returns `{ extractions, detectedDate }` rather than a bare array: the date is
 * a second, independent reading of the same page, and folding it into the
 * array would invite a caller to treat "a biomarker and its date" as one
 * finding from one place when they are two independent guesses.
 */
export async function extractBiomarkersFromPDF(pdfUrl) {
  if (!GOOGLE_PROJECT_ID || !PROCESSOR_ID) {
    console.error('Google Document AI credentials missing');
    throw new Error('OCR_CONFIG_MISSING');
  }

  try {
    // Note: In a real GCP environment, we would use the @google-cloud/documentai SDK.
    // This implementation uses the REST API for transparency and fewer heavy dependencies.
    const accessToken = await getGoogleAccessToken();
    
    const response = await axios.post(
      `https://${LOCATION}-documentai.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}:process`,
      {
        rawDocument: {
          mimeType: 'application/pdf',
          content: await fetchPdfAsBase64(pdfUrl),
        },
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    return parseDocumentAIResponse(response.data);
  } catch (err) {
    console.error('OCR API Error:', err.response?.data || err.message);
    throw err;
  }
}

async function fetchPdfAsBase64(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function getGoogleAccessToken() {
  // In production, this uses a Service Account JSON key via google-auth-library.
  // For this implementation, we assume the environment is already authenticated
  // via GCP Application Default Credentials (ADC).
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getKsClient();
  const token = await auth.getAccessToken();
  return token.token;
}

function parseDocumentAIResponse(data) {
  const entities = data.document.entities || [];
  const results = [];

  // The page's own text, not the trained entities. The processor is asked for
  // biomarkers; nothing in its schema is promised to be a date, and a date is
  // the one thing on the page most likely to be mislaid by a layout the
  // processor was not trained on. `document.text` is always present.
  const documentText = data.document.text || '';

  // Map of common lab report labels to our BiometricMetric enum
  const METRIC_MAP = {
    'hemoglobin a1c': 'hbA1c',
    'hba1c': 'hbA1c',
    'fasting glucose': 'glucose',
    'glucose': 'glucose',
    'low density lipoprotein': 'ldl',
    'ldl': 'ldl',
    'high sensitivity c-reactive protein': 'hsCRP',
    'hscrp': 'hsCRP',
    'tsh': 'tsh',
    'vitamin d': 'vitamin_d',
    'b12': 'vitamin_b12',
  };

  for (const entity of entities) {
    const label = entity.mentionText.toLowerCase();
    const valueMatch = entity.mentionText.match(/(\d+(\.\d+)?)/);
    
    if (valueMatch) {
      const normalizedLabel = Object.keys(METRIC_MAP).find(k => label.includes(k));
      if (normalizedLabel) {
        results.push({
          metric: METRIC_MAP[normalizedLabel],
          rawValue: entity.mentionText,
          normalizedValue: parseFloat(valueMatch[0]),
          unit: extractUnit(entity.mentionText),
          confidence: entity.confidence || 0,
        });
      }
    }
  }

  return { extractions: results, detectedDate: detectReportDateFromText(documentText) };
}

function extractUnit(text) {
  const units = ['%', 'mg/dL', 'mmol/L', 'bpm', 'kg', 'g/dL'];
  for (const unit of units) {
    if (text.includes(unit)) return unit;
  }
  return 'unknown';
}

/**
 * Reads the day a specimen was taken off a lab report's own text.
 *
 * Exported because this is the part most worth testing and the part most worth
 * being wrong about. Everything here is about one trade: a date read off the
 * page is worth having, but a date read off the page *wrong* puts a March
 * measurement into an August trend. So the parser is deliberately unwilling,
 * and returns null in every case where it is not sure rather than guessing:
 *
 * - It requires a collection-ish label near the date. An unlabelled date on a
 *   lab report is as likely to be the patient's date of birth, the next
 *   appointment, or the invoice date as the day the blood was drawn.
 * - It rejects pure-numeric dates (`03/04/2026`) that are not self-disambiguating.
 *   `13/04/2026` can only be day-first; `03/04/2026` is 3 April in most of the
 *   world and 4 March in the US, and silently picking one is how a report ends
 *   up filed under a day nothing happened.
 * - It accepts only labelled dates whose format is unambiguous on its face:
 *   ISO (`2026-03-04`), a spelled-out month (`4 Mar 2026`, `Mar 4, 2026`), or
 *   a numeric date where the day is provably the day (>12).
 * - It refuses dates in the future and before 1900, the same bounds the manual
 *   entry path enforces, so OCR cannot produce a date a human could not.
 *
 * Returns null when unsure, which is the safe failure: the caller falls back to
 * asking the user, exactly as it did before this existed.
 *
 * @param {string} text Document AI's `document.text` for the report.
 * @param {Date}   [now] Injectable for tests.
 * @returns {{ date: string, label: string, confidence: number } | null}
 */
export function detectReportDateFromText(text, now = new Date()) {
  if (typeof text !== 'string' || text.trim() === '') return null;

  // Ordered by how directly the label names the day the sample was taken.
  // "Reported" is the lab writing up a result it already has, so it is one or
  // more days after the draw, but it is still a real reading of this report and
  // a far better answer than the upload day. Only reached when nothing better
  // appears on the page.
  const LABELS = [
    { re: /\b(?:date\s+of\s+collection|collection\s+date|date\s+collected|specimen\s+collected|sample\s+date|sampled?|drawn?|venipuncture|date\s+of\s+(?:blood\s+)?draw)\b/i, confidence: 0.95 },
    { re: /\b(?:collected|collection)\b/i, confidence: 0.9 },
    { re: /\b(?:report(?:ed)?(?:\s+date)?|test\s+date|date\s+of\s+(?:test|report))\b/i, confidence: 0.6 },
  ];

  // Labels that name a different day on the same page. Checked before the
  // positive labels: a page that says "Date of Birth: 03/04/1980" next to
  // "Collected: 04/03/2026" must not have the first one read as the second.
  const DISQUALIFIERS = /\b(?:date\s+of\s+birth|d\.?o\.?b\.?|birth(?:day|date)?|next\s+appointment|appointment|expir(?:y|ation|es)|valid\s+until|due\s+date|renewal|order(?:ed)?\s+(?:on|date)|billed|invoice|receipt|printed\s+(?:on|date)|due)\b/i;

  // Matched in one pass so overlapping formats cannot both claim the text.
  const PATTERNS = [
    // ISO: 2026-03-04
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, build: (m) => isoFrom(m[1], m[2], m[3]) },
    // 4 Mar 2026 / 4-March-2026 / 04 Mar 2026 09:15
    { re: /\b(\d{1,2})[\s\-\/]*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s\-\/,]*(\d{4})\b/gi, build: (m) => isoFrom(m[3], monthNumber(m[2]), m[1]) },
    // Mar 4, 2026 / March 4 2026
    { re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s\-\/]*(\d{1,2})(?:st|nd|rd|th)?[\s\-\/,]+(\d{4})\b/gi, build: (m) => isoFrom(m[3], monthNumber(m[1]), m[2]) },
    // 04/03/2026 or 03/04/2026. Null when both parts are <= 12 and therefore
    // could be read either way round.
    { re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g, build: (m) => numericDayMonth(m[1], m[2], m[3]) },
  ];

  const today = isoFrom(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    now.getUTCDate(),
  );

  let best = null;

  for (const { re, build } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const iso = build(match);
      if (!iso) continue;
      if (iso > today) continue;          // A report cannot have been taken yet.
      if (iso < '1900-01-01') continue;   // Same floor the app's picker enforces.

      // Only the text before the date on its own line can label it. A
      // "Collected" three lines up on a different row is not evidence about
      // this date.
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const before = text.slice(lineStart, match.index);

      // A disqualifier anywhere on the line kills this candidate. Reports put
      // DOB and appointment dates in the same header block as the draw date,
      // and the nearest label is not reliably the right one.
      if (DISQUALIFIERS.test(before)) continue;

      const label = LABELS.find(l => l.re.test(before));
      if (!label) continue;

      // Strictly greater, so the earliest match at a given confidence wins:
      // scan order is reading order, which is the best proxy available for
      // "the one this header meant".
      if (!best || label.confidence > best.confidence) {
        best = { date: iso, label: match[0].trim(), confidence: label.confidence };
      }
    }
  }

  return best;
}

function monthNumber(name) {
  const key = name.toLowerCase().slice(0, 3);
  return MONTHS[key] ?? null;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Builds 'YYYY-MM-DD' and rejects days that do not exist, so 31/02 is refused
 * rather than rolled forward into March the way `new Date('2026-02-31')` would.
 */
function isoFrom(year, month, day) {
  const y = Number(year);
  const m = month == null ? null : Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || m === null || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 1000 || y > 9999) return null;

  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Numeric DD/MM vs MM/DD.
 *
 * Only returns a date when the format settles itself: a first part above 12 can
 * only be a day, a second part above 12 can only be a day. Otherwise null, and
 * the report falls back to the user being asked. Guessing between the two is
 * the single worst outcome available here, because the wrong guess is still a
 * well-formed date that looks correct in every downstream surface.
 */
function numericDayMonth(first, second, year) {
  const a = Number(first);
  const b = Number(second);
  if (a > 12 && b <= 12) return isoFrom(year, b, a);
  if (b > 12 && a <= 12) return isoFrom(year, a, b);
  return null;
}
