export const MAX_REPORT_READINGS = 500;

const limits = { label: 160, value: 120, unit: 48, referenceRange: 120, flag: 40 };
const invalid = message => Object.assign(new Error(message), { status: 400 });

export function validateReportReadings(input) {
  if (!Array.isArray(input) || input.length > MAX_REPORT_READINGS) {
    throw invalid(`Provide up to ${MAX_REPORT_READINGS} report readings`);
  }
  return input.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid(`Check reading ${index + 1}`);
    const reading = {};
    for (const [key, max] of Object.entries(limits)) {
      const raw = row[key];
      if (raw == null && key !== 'label' && key !== 'value') continue;
      if (typeof raw !== 'string' || raw.trim().length > max) throw invalid(`Check reading ${index + 1}`);
      const clean = raw.trim();
      if (!clean && (key === 'label' || key === 'value')) throw invalid(`Check reading ${index + 1}`);
      if (clean) reading[key] = clean;
    }
    return reading;
  });
}

export const identityLabel = /^(?:patient(?:\b|_)|name\b|age\b|sex\b|gender\b|address\b|date\b|report(?:ed|\s*(?:no|id|date))\b|sample(?:\s*(?:no|id|date))\b|collected\b|received\b|referr(?:ed|ing)\b|page\b|barcode\b|accession\b|signature\b|lab\s*(?:no|id|name)\b|mobile\b|phone\b|contact\b|e-?mail\b|tel\b|website\b|www\b|nabl\b|cin\b|gstin?\b|pan\b|doctor\b|dr\b|consultant\b|pathologist\b|technician\b|technologist\b|approved\b|authori[sz]ed\b|printed\b|processed\b)/i;

// These are column headings found across labs. Test names in the rows are data.
function columnRole(text) {
  const s = text.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (/^(?:(?:biological|bio|normal|expected) )?(?:ref(?:erence)?(?: (?:range|interval|values?))?|range|interval)$|^(?:normal|expected) values?$/.test(s)) return 'referenceRange';
  if (/^(?:test(?: (?:name|description|parameter))?|investigation(?: name)?|parameter(?: name)?|component|analyte|examination|description|particulars)$/.test(s)) return 'label';
  if (/^(?:(?:observed|measured|actual|test|patient) )?(?:results?|values?|findings|reading)(?: values?)?$/.test(s)) return 'value';
  if (/^(?:unit|units|uom)$/.test(s)) return 'unit';
  if (/^(?:flag|flags|status|abnormal)$/.test(s)) return 'flag';
  if (/^(?:method(?:ology)?|technique|interpretation|remarks|comment|comments)$/.test(s)) return 'ignore';
  return null;
}

function cleanReading(cells, columns) {
  const fields = {};
  for (let i = 0; i < columns.length; i++) {
    const key = columns[i];
    const value = cells[i]?.replace(/\s+/g, ' ').trim();
    if (value && limits[key] && value.length <= limits[key]) fields[key] = value;
  }
  if (!fields.label || !fields.value || identityLabel.test(fields.label) || !/\p{L}/u.test(fields.label) || columnRole(fields.label)) return null;
  return fields;
}

function wordsForPage(page, text) {
  return (page.tokens || []).map(({ layout }) => {
    const vertices = layout?.boundingPoly?.normalizedVertices;
    if (!vertices?.length) return null;
    const word = (layout.textAnchor?.textSegments || [])
      .map(part => text.slice(Number(part.startIndex || 0), Number(part.endIndex)))
      .join('').trim();
    if (!word) return null;
    const xs = vertices.map(p => p.x || 0), ys = vertices.map(p => p.y || 0);
    return { word, x: Math.min(...xs), right: Math.max(...xs), y: (Math.min(...ys) + Math.max(...ys)) / 2, height: Math.max(...ys) - Math.min(...ys) };
  }).filter(Boolean);
}

function spatialRows(words) {
  const heights = words.map(w => w.height).filter(h => h > 0).sort((a, b) => a - b);
  const tolerance = (heights[Math.floor(heights.length / 2)] || 0.012) * 0.55;
  const rows = [];
  for (const word of words.sort((a, b) => a.y - b.y)) {
    const row = rows.at(-1);
    if (!row || word.y - row.y > tolerance) rows.push({ y: word.y, words: [word] });
    else row.words.push(word);
  }
  return rows.map(row => ({ ...row, words: row.words.sort((a, b) => a.x - b.x) }));
}

function headerColumns(words) {
  const groups = [];
  for (const word of words) {
    const last = groups.at(-1);
    if (!last || word.x - last.right > 0.022) groups.push({ x: word.x, right: word.right, text: word.word });
    else { last.text += ` ${word.word}`; last.right = word.right; }
  }
  const columns = groups.map(g => ({ x: g.x, role: columnRole(g.text) })).filter(g => g.role);
  const roles = columns.map(g => g.role);
  return roles.indexOf('label') !== -1 && roles.indexOf('label') < roles.indexOf('value') ? columns : null;
}

// A row found after the table's own header has gone stale (a new page without a
// repeated header, or a large blank after the last row) is accepted only when it
// looks like a result: a short label and a bare number, comparator or a single
// qualitative word. Inside a live table anything with a label and a value is
// kept, as before. Outside one, narrative sentences and footers are the risk,
// and a bare number is the signature of a real lab row.
const STRICT_VALUE = /^(?:[<>≤≥]=?\s*)?\d[\d.,]*(?:\s*[-–]\s*\d[\d.,]*)?$|^(?:negative|positive|nil|absent|present|reactive|non[\s-]?reactive|trace|detected|not\s+detected)$/i;
const looksLikeResult = reading => STRICT_VALUE.test(reading.value) && reading.label.split(/\s+/).length <= 8;

// A label printed over two lines: "Glycosylated Hemoglobin" on one row and
// "(HbA1c)" on the next, in whichever order the lab chose. Joined only when the
// shape says so, because a label-only row is just as often a section heading.
const OPEN_ENDING = /[(\-/,&]$|\b(?:and|of|with|for)$/i;
const isParenthetical = text => text.startsWith('(');
const SAME_BLOCK = 0.05;

function fromLayout(document) {
  const readings = [];
  // Carried across pages: lab tables routinely continue on the next page
  // without repeating their header, and every row there used to be lost.
  let columns = null;
  let boundaries = [];
  let stale = false;
  for (const page of document.pages || []) {
    let lastY = null;
    let previous = null; // { reading, y }: the last row on this page that became a reading
    let dangling = null; // { text, y }: a label-only row waiting for its value row
    // A new page may open with a repeated patient header rather than the table.
    if (columns) stale = true;
    for (const row of spatialRows(wordsForPage(page, document.text))) {
      const header = headerColumns(row.words);
      if (header) {
        columns = header;
        boundaries = header.slice(1).map((col, i) => (header[i].x + col.x) / 2);
        lastY = row.y;
        stale = false;
        previous = dangling = null;
        continue;
      }
      if (!columns) continue;
      // A large blank separates the lab table from narrative and footer text.
      // It no longer ends the table (a second panel on the same page often has
      // no header of its own); it only tightens what is accepted afterwards.
      if (lastY !== null && row.y - lastY > 0.075) stale = true;
      lastY = row.y;
      const cells = columns.map(() => []);
      for (const word of row.words) {
        const index = boundaries.findLastIndex(x => word.x >= x) + 1;
        cells[index].push(word.word);
      }
      const text = cells.map(parts => parts.join(' '));
      const roles = columns.map(c => c.role);
      const reading = cleanReading(text, roles);
      if (reading) {
        if (stale && !looksLikeResult(reading)) { dangling = null; continue; }
        if (dangling && row.y - dangling.y < SAME_BLOCK && isParenthetical(reading.label)) {
          reading.label = `${dangling.text} ${reading.label}`.slice(0, limits.label);
        }
        readings.push(reading);
        previous = { reading, y: row.y };
        dangling = null;
        continue;
      }
      // No value on this row. When only the label cell has text it is half of a
      // wrapped label or a section heading.
      const label = text[0]?.replace(/\s+/g, ' ').trim();
      const labelOnly = roles[0] === 'label' && label && text.slice(1).every(cell => !cell);
      if (labelOnly && !identityLabel.test(label) && !columnRole(label)) {
        if (previous && row.y - previous.y < SAME_BLOCK && (isParenthetical(label) || OPEN_ENDING.test(previous.reading.label))) {
          previous.reading.label = `${previous.reading.label} ${label}`.slice(0, limits.label);
          previous.y = row.y;
        } else {
          dangling = { text: label, y: row.y };
        }
      } else {
        dangling = null;
      }
    }
  }
  return readings;
}

function fromDelimitedText(text) {
  const readings = [];
  let columns = null;
  for (const line of text.split(/\r?\n/)) {
    const cells = line.trim().split(/\t+| {2,}|\s*\|\s*/);
    if (cells.length < 2) continue;
    const roles = cells.map(columnRole);
    if (roles.includes('label') && roles.includes('value')) { columns = roles; continue; }
    const reading = columns && cleanReading(cells, columns);
    if (reading) readings.push(reading);
  }
  return readings;
}

export function extractReportReadings(document) {
  if (typeof document?.text !== 'string' || !document.text.trim()) return [];
  const rows = fromLayout(document);
  return (rows.length ? rows : fromDelimitedText(document.text)).slice(0, MAX_REPORT_READINGS);
}
