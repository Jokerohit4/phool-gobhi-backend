import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricForLabel, canonicalValue, valuesFromReadings, BIOMETRIC_BOUNDS } from '../utils/readingMetrics.js';
import { METRIC_BOUNDS } from '../services/biometricService.js';

test('the local biometric bounds cannot drift from the stored ones', () => {
  for (const [key, bounds] of Object.entries(BIOMETRIC_BOUNDS)) assert.deepEqual(bounds, METRIC_BOUNDS[key], key);
});

test('labels map to metrics, and look-alikes do not', () => {
  assert.equal(metricForLabel('Glycosylated Hemoglobin (HbA1c)'), 'hba1c');
  assert.equal(metricForLabel('Hb A1c'), 'hba1c');
  assert.equal(metricForLabel('LDL Cholesterol'), 'ldl');
  assert.equal(metricForLabel('HDL CHOLESTEROL'), 'hdl');
  assert.equal(metricForLabel('Triglycerides'), 'triglycerides');
  assert.equal(metricForLabel('SGPT (ALT)'), 'sgpt');
  assert.equal(metricForLabel('AST (SGOT)'), 'sgot');
  for (const label of ['LDL/HDL Ratio', 'Non-HDL Cholesterol', 'VLDL Cholesterol', 'Hemoglobin', 'Fasting Glucose', '']) {
    assert.equal(metricForLabel(label), null, label);
  }
});

test('values are converted to the stored unit and misreads are refused', () => {
  assert.equal(canonicalValue('hba1c', '5.8', '%'), 5.8);
  assert.equal(canonicalValue('hba1c', '48', 'mmol/mol'), 6.54);
  assert.equal(canonicalValue('ldl', '2.6', 'mmol/L'), 100.54);
  assert.equal(canonicalValue('triglycerides', '1.7', 'mmol/L'), 150.57);
  assert.equal(canonicalValue('sgpt', '32', 'U/L'), 32);
  assert.equal(canonicalValue('hdl', '45', ''), 45);
  assert.equal(canonicalValue('hdl', '45', 'g/dL'), null, 'unconvertible unit');
  assert.equal(canonicalValue('hba1c', '<4', '%'), null, 'comparator is not a measurement');
  assert.equal(canonicalValue('hba1c', '58', '%'), null, 'out of bounds');
  assert.equal(canonicalValue('hba1c', 'Negative', ''), null);
});

test('first usable row per marker wins and unusable rows are skipped', () => {
  assert.deepEqual(valuesFromReadings([
    { label: 'HbA1c', value: '<4', unit: '%' },
    { label: 'Glycated Haemoglobin', value: '6.1', unit: '%' },
    { label: 'HbA1c', value: '9.9', unit: '%' },
    { label: 'LDL/HDL Ratio', value: '2.8' },
    { label: 'LDL Cholesterol', value: '131', unit: 'mg/dL' },
    { label: 'Hemoglobin', value: '13.5', unit: 'g/dL' },
  ]), { hba1c: 6.1, ldl: 131 });
});
