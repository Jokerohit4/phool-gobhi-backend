import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReportReadings } from '../utils/reportReadings.js';

// pages: [[{ y, cells: [[word, x], ...] }, ...], ...]. y is the row's centre line.
function ocrDocument(pages) {
  let text = '';
  const built = pages.map(rows => {
    const tokens = [];
    for (const { y, cells } of rows) {
      for (const [word, x] of cells) {
        const startIndex = text.length;
        text += word;
        tokens.push({ layout: {
          textAnchor: { textSegments: [{ startIndex, endIndex: text.length }] },
          boundingPoly: { normalizedVertices: [{ x, y: y - 0.006 }, { x: x + 0.02, y: y + 0.006 }] },
        } });
        text += ' ';
      }
      text += '\n';
    }
    return { tokens };
  });
  return { text, pages: built };
}

const header = y => ({ y, cells: [['Test', 0.15], ['Result', 0.40], ['Unit', 0.53], ['Bio. Ref. Interval', 0.68]] });
const row = (y, label, value, unit, range) => ({
  y,
  cells: [
    ...label.split(' ').map((word, i) => [word, 0.05 + i * 0.07]),
    [value, 0.38],
    ...(unit ? [[unit, 0.51]] : []),
    ...(range ? [[range, 0.64]] : []),
  ],
});

test('a table that continues on the next page without its header is still read', () => {
  const document = ocrDocument([
    [header(0.2), row(0.224, 'Hemoglobin', '13.5', 'g/dL', '13-17')],
    [
      // The repeated patient banner a lab prints at the top of every page.
      { y: 0.1, cells: [['Patient', 0.05], ['Name', 0.12], ['Priya', 0.38]] },
      { y: 0.124, cells: [['Lab', 0.05], ['No', 0.1], ['10293', 0.38]] },
      row(0.2, 'Creatinine', '0.9', 'mg/dL', '0.6-1.2'),
      row(0.224, 'Urea', '28', 'mg/dL', '15-40'),
    ],
  ]);
  assert.deepEqual(extractReportReadings(document).map(r => r.label), ['Hemoglobin', 'Creatinine', 'Urea']);
});

test('a second panel after a blank gap is read, but narrative under it is not', () => {
  const document = ocrDocument([[
    header(0.2),
    row(0.224, 'Glucose', '92', 'mg/dL', '70-100'),
    // 0.12 of blank page, then a panel with no header of its own.
    row(0.344, 'Creatinine', '0.9', 'mg/dL', '0.6-1.2'),
    row(0.368, 'Uric Acid', '5.1', 'mg/dL', '3.5-7.2'),
    { y: 0.42, cells: [['Note', 0.05], ['Reference', 0.38], ['ranges', 0.45], ['vary', 0.5], ['by', 0.55], ['lab', 0.6]] },
    { y: 0.444, cells: [['Interpretation', 0.05], ['5.7', 0.38], ['to', 0.43], ['6.4', 0.47], ['is', 0.52], ['prediabetes', 0.56]] },
  ]]);
  assert.deepEqual(extractReportReadings(document).map(r => r.label), ['Glucose', 'Creatinine', 'Uric Acid']);
});

test('a label wrapped over two rows is joined in either order', () => {
  const before = ocrDocument([[
    header(0.2),
    { y: 0.224, cells: [['Glycosylated', 0.05], ['Hemoglobin', 0.13]] },
    row(0.248, '(HbA1c)', '5.8', '%', '4-5.6'),
  ]]);
  assert.deepEqual(extractReportReadings(before).map(r => r.label), ['Glycosylated Hemoglobin (HbA1c)']);

  const after = ocrDocument([[
    header(0.2),
    row(0.224, 'Hemoglobin A1c (', '5.8', '%', '4-5.6'),
    { y: 0.248, cells: [['IFCC)', 0.05]] },
  ]]);
  assert.deepEqual(extractReportReadings(after).map(r => r.label), ['Hemoglobin A1c ( IFCC)']);
});

test('a section heading is not glued onto the reading above it', () => {
  const document = ocrDocument([[
    header(0.2),
    row(0.224, 'Glucose', '92', 'mg/dL', '70-100'),
    { y: 0.248, cells: [['LIPID', 0.05], ['PROFILE', 0.11]] },
    row(0.272, 'Triglycerides', '140', 'mg/dL', '<150'),
  ]]);
  assert.deepEqual(extractReportReadings(document).map(r => r.label), ['Glucose', 'Triglycerides']);
});
