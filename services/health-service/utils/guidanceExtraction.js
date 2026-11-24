// Only labelled patient fields are proposed. Never infer DOB from age or use a lab's address.
export function extractGuidanceDetails(text = '') {
  const take = (re, max = 200) => text.match(re)?.[1]?.trim().slice(0, max) || null;
  const age = take(/\b(?:patient\s+)?age(?:\s*\/\s*(?:sex|gender))?\s*[:\-]\s*(\d{1,3})\s*(?:years?|yrs?|y\b)/i);
  const sex = take(/\b(?:sex|gender)\s*[:\-]\s*(female|male|other|f|m)\b/i) || take(/\bage\s*\/\s*(?:sex|gender)\s*[:\-]\s*\d{1,3}\s*(?:years?|yrs?|y)?\s*\/\s*(female|male|other|f|m)\b/i);
  const profile = {
    name: take(/(?:^|\n)\s*(?:patient\s+name|name\s+of\s+patient|patient|name)\s*[:\-]\s*([^\n\r|]+?)(?=\s+(?:age|sex|gender)\s*[:\-]|[\n\r|]|$)/i, 120),
    age: age && Number(age) <= 120 ? Number(age) : null,
    gender: sex ? ({ f: 'female', m: 'male' }[sex.toLowerCase()] || sex.toLowerCase()) : null,
    address: take(/(?:^|\n)\s*patient\s+address\s*[:\-]\s*([^\n\r|]+)/i, 500),
  };
  const markers = {};
  for (const [key, label] of [['sgot', '(?:sgot|ast)'], ['sgpt', '(?:sgpt|alt)']]) {
    const match = text.match(new RegExp(`(?:^|\\n)\\s*${label}\\b[^\\n\\d]*?(\\d+(?:\\.\\d+)?)\\s*(?:u\\/l|iu\\/l)`, 'i'));
    if (match) markers[key] = Number(match[1]);
  }
  const bp = text.match(/\b(?:blood\s+pressure|bp)\s*[:\-]\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:mm\s*hg)?/i);
  if (bp) { markers.systolic = Number(bp[1]); markers.diastolic = Number(bp[2]); }
  if (/(?:^|\n)\s*(?:sgot|sgpt|ast|alt)\b[^\n]*(?:\bHIGH\b|\bELEVATED\b|(?:iu\/l|u\/l)\s+H\b)/i.test(text)) markers.liverFlag = true;
  return { profile, markers };
}

export const GUIDANCE_BOUNDS = Object.freeze({ hba1c: [2, 25], triglycerides: [10, 5000], sgot: [0, 10000], sgpt: [0, 10000], systolic: [50, 300], diastolic: [30, 200] });
export function validateMarkers(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Invalid marker values'), { status: 400 });
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(key in GUIDANCE_BOUNDS)) throw Object.assign(new Error(`Unknown marker: ${key}`), { status: 400 });
    if (value == null || value === '') continue;
    const n = Number(value), [min, max] = GUIDANCE_BOUNDS[key];
    if (typeof value === 'boolean' || !Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`Check ${key}`), { status: 400 });
    out[key] = n;
  }
  return out;
}
// The common adult upper limit for the liver enzymes. Labs print their own range
// and it varies, so this only decides AMBER (a prompt for the clinician review
// that every confirmed report gets), never anything stronger.
export const LIVER_ENZYME_ULN = 40;

export function riskBucket(markers, liverFlag = false) {
  if (markers.hba1c >= 6.5 || markers.systolic >= 140 || markers.diastolic >= 90) return 'RED';
  const liverHigh = markers.sgot > LIVER_ENZYME_ULN || markers.sgpt > LIVER_ENZYME_ULN;
  if (markers.hba1c >= 5.7 || markers.triglycerides >= 150 || liverFlag || liverHigh) return 'AMBER';
  // GREEN is a positive statement, and every threshold above hangs on HbA1c. A
  // report where it was not read (or a lone normal triglyceride) is incomplete,
  // not healthy, and telling someone they are green on that is the wrong error.
  return markers.hba1c != null ? 'GREEN' : 'UNSET';
}
