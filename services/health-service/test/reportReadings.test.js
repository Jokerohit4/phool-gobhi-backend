import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReportReadings, validateReportReadings } from '../utils/reportReadings.js';

function ocrTable(lines) {
  let text = '';
  const tokens = [];
  for (let index = 0; index < lines.length; index++) {
    for (const [word, x] of lines[index]) {
      const startIndex = text.length;
      const y = 0.2 + index * 0.024;
      text += word;
      tokens.push({ layout: {
        textAnchor: { textSegments: [{ startIndex, endIndex: text.length }] },
        boundingPoly: { normalizedVertices: [{ x, y }, { x: x + 0.02, y: y + 0.012 }] },
      } });
      text += ' ';
    }
    text += '\n';
  }
  return { text, pages: [{ tokens }] };
}

test('reads arbitrary lab labels, comparators, units, ranges and flags from OCR columns', () => {
  // Headers are centered but the lab rows are aligned to the left of each column.
  const document = ocrTable([
    [['Test', 0.15], ['Result', 0.40], ['Unit', 0.53], ['Bio. Ref. Interval', 0.68], ['Flag', 0.84]],
    [['Urine', 0.05], ['glucose', 0.09], ['Negative', 0.38], ['Negative', 0.64]],
    [['Bilirubin', 0.05], ['direct', 0.12], ['<0.2', 0.38], ['mg/dL', 0.51], ['0–0.3', 0.64], ['L', 0.84]],
    [['Lab-specific index (X-12)', 0.05], ['3.4', 0.38]],
    [['Color', 0.05], ['Amber', 0.38]],
    [['Patient age', 0.05], ['35', 0.38]],
    [['Bilirubin', 0.05], ['direct', 0.12], ['0.3', 0.38], ['mg/dL', 0.51]],
  ]);
  assert.deepEqual(extractReportReadings(document), [
    { label: 'Urine glucose', value: 'Negative', referenceRange: 'Negative' },
    { label: 'Bilirubin direct', value: '<0.2', unit: 'mg/dL', referenceRange: '0–0.3', flag: 'L' },
    { label: 'Lab-specific index (X-12)', value: '3.4' },
    { label: 'Color', value: 'Amber' },
    { label: 'Bilirubin direct', value: '0.3', unit: 'mg/dL' },
  ]);
});

test('delimited tables work without coordinates and plain narrative does not become a reading', () => {
  assert.deepEqual(extractReportReadings({ text: 'Investigation | Observed value | Unit | Reference range\nUncatalogued test | 12 | ng/mL | 10–20\nNarrative: 10' }), [
    { label: 'Uncatalogued test', value: '12', unit: 'ng/mL', referenceRange: '10–20' },
  ]);
  assert.deepEqual(extractReportReadings({ text: 'Date: 2026-11-20\nA comment with 72 in it.' }), []);
});

test('reviewed results preserve printed text and discard unrelated properties', () => {
  assert.deepEqual(validateReportReadings([
    { label: ' Test X ', value: ' Not detected ', unit: '', helper: 'discard' },
  ]), [{ label: 'Test X', value: 'Not detected' }]);
  for (const rows of [null, [{}], [{ label: 'Test', value: 13 }], [{ label: 'Test', value: ' ' }], Array(501).fill({ label: 'Test', value: '13' })]) {
    assert.throws(() => validateReportReadings(rows), { status: 400 });
  }
});
