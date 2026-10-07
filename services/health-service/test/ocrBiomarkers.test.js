import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentAIResponse } from '../utils/ocrService.js';
import { METRIC_UNITS } from '../services/biometricService.js';

const entity = (mentionText, extra = {}) => ({ mentionText, confidence: 0.9, ...extra });
const parse = (entities = [], text = '') => parseDocumentAIResponse({ document: { entities, text } }).extractions;
const byMetric = (extractions) => Object.fromEntries(extractions.map((e) => [e.metric, e]));

describe('parseDocumentAIResponse biomarkers', () => {
  test('emits only BiometricMetric members, so createMany cannot reject the report', () => {
    const out = parse([
      entity('HbA1c 5.8 %'),
      entity('Fasting Glucose 92 mg/dL'),
      entity('TSH 2.1 uIU/mL'),
      entity('Vitamin D 28 ng/mL'),
      entity('Vitamin B12 410 pg/mL'),
      entity('hsCRP 1.2 mg/L'),
      entity('LDL Cholesterol 118 mg/dL'),
    ]);
    for (const ex of out) assert.ok(ex.metric in METRIC_UNITS, `${ex.metric} is not storable`);
    assert.deepEqual(out.map((e) => e.metric).sort(), ['hba1c', 'ldl']);
  });

  test('reads the value after the label, not the 1 inside "A1c"', () => {
    assert.equal(byMetric(parse([entity('HbA1c 5.8 %')])).hba1c.normalizedValue, 5.8);
  });

  test('recognises HDL and triglycerides, which the old map never did', () => {
    const out = byMetric(parse([entity('HDL Cholesterol 52 mg/dL'), entity('Triglycerides 140 mg/dL')]));
    assert.equal(out.hdl.normalizedValue, 52);
    assert.equal(out.triglycerides.normalizedValue, 140);
  });

  test('skips ratio, non-HDL and VLDL lines instead of reading them as LDL or HDL', () => {
    const out = parse([
      entity('LDL/HDL Ratio 2.8'),
      entity('Non-HDL Cholesterol 160 mg/dL'),
      entity('VLDL Cholesterol 28 mg/dL'),
    ]);
    assert.deepEqual(out, []);
  });

  test('converts mmol/L lipids and mmol/mol HbA1c into the stored units', () => {
    const out = byMetric(parse([
      entity('LDL 3.0 mmol/L'),
      entity('Triglycerides 1.2 mmol/L'),
      entity('HbA1c 40 mmol/mol'),
    ]));
    assert.equal(out.ldl.normalizedValue, 116.01);
    assert.equal(out.ldl.unit, 'mg/dL');
    assert.equal(out.triglycerides.normalizedValue, 106.28);
    assert.equal(out.hba1c.normalizedValue, 5.81);
    assert.equal(out.hba1c.unit, '%');
  });

  test('reads a custom-extractor entity whose label is in `type`', () => {
    const out = byMetric(parse([entity('52', { type: 'hdl_cholesterol' })]));
    assert.equal(out.hdl.normalizedValue, 52);
  });

  test('drops a number outside the plausibility bounds as a misread', () => {
    assert.deepEqual(parse([entity('HbA1c 2026')]), []);
  });

  test('keeps one extraction per marker, the most confident', () => {
    const out = parse([
      entity('LDL 120 mg/dL', { confidence: 0.6 }),
      entity('LDL 118 mg/dL', { confidence: 0.95 }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].normalizedValue, 118);
  });

  test('falls back to the page text when there are no entities, including a value on the next line', () => {
    const text = [
      'LIPID PROFILE',
      'Triglycerides 150 mg/dL 0-150',
      'HDL Cholesterol',
      '45 mg/dL',
      'Glycated Haemoglobin (HbA1c) 6.1 %',
    ].join('\n');
    const out = byMetric(parse([], text));
    assert.equal(out.triglycerides.normalizedValue, 150);
    assert.equal(out.hdl.normalizedValue, 45);
    assert.equal(out.hba1c.normalizedValue, 6.1);
    assert.equal(out.hdl.confidence, 0);
  });

  test('an entity outranks the text fallback for the same marker', () => {
    const out = parse([entity('LDL 118 mg/dL')], 'LDL 999 mg/dL\nLDL 130 mg/dL');
    assert.equal(out.length, 1);
    assert.equal(out[0].normalizedValue, 118);
  });
});
