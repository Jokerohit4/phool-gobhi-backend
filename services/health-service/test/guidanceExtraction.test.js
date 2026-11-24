import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGuidanceDetails, riskBucket, validateMarkers } from '../utils/guidanceExtraction.js';

test('only labelled patient identity is proposed; age never becomes DOB', () => {
  const out = extractGuidanceDetails('Lab Name: Central Diagnostics\nAddress: Lab Road\nPatient Name: Priya Mehta\nAge: 31 years\nSex: Female\nPatient Address: Indiranagar\nSGPT: 32 U/L\nBP: 142/92 mmHg');
  assert.deepEqual(out.profile, { name: 'Priya Mehta', age: 31, gender: 'female', address: 'Indiranagar' });
  assert.deepEqual(out.markers, { sgpt: 32, systolic: 142, diastolic: 92 });
  assert.equal(Object.hasOwn(out.profile, 'dateOfBirth'), false);
});
test('unlabelled names, dates and lab addresses do not fill patient details', () => {
  assert.deepEqual(extractGuidanceDetails('Doctor: Other Person\nAddress: Lab Street\nDate: 2026-01-01').profile, { name: null, age: null, gender: null, address: null });
});
test('triage uses confirmed thresholds; missing values are not a green assessment', () => {
  assert.equal(riskBucket({}), 'UNSET');
  assert.equal(riskBucket({ hba1c: 6.5 }), 'RED');
  assert.equal(riskBucket({ systolic: 140 }), 'RED');
  assert.equal(riskBucket({ diastolic: 90 }), 'RED');
  assert.equal(riskBucket({ hba1c: 5.7 }), 'AMBER');
  assert.equal(riskBucket({ triglycerides: 150 }), 'AMBER');
  assert.equal(riskBucket({}, true), 'AMBER');
  assert.equal(riskBucket({ hba1c: 5.2, triglycerides: 120 }), 'GREEN');
});
test('green needs HbA1c; partial reports are unset, and raised liver enzymes are amber', () => {
  assert.equal(riskBucket({ triglycerides: 120 }), 'UNSET');
  assert.equal(riskBucket({ systolic: 118, diastolic: 76 }), 'UNSET');
  assert.equal(riskBucket({ hba1c: 5.2, sgpt: 41 }), 'AMBER');
  assert.equal(riskBucket({ hba1c: 5.2, sgot: 60 }), 'AMBER');
  assert.equal(riskBucket({ hba1c: 5.2, sgot: 40, sgpt: 35 }), 'GREEN');
  assert.equal(riskBucket({ sgpt: 120 }), 'AMBER');
  assert.equal(riskBucket({ hba1c: 6.6, sgpt: 120 }), 'RED');
});
test('confirmation rejects negative, infinite, boolean, unknown and implausible values', () => {
  for (const markers of [{ hba1c: -1 }, { systolic: Infinity }, { hba1c: true }, { diagnosis: 1 }, { hba1c: 300 }]) assert.throws(() => validateMarkers(markers));
  assert.deepEqual(validateMarkers({ hba1c: '6.2', triglycerides: '', sgpt: null }), { hba1c: 6.2 });
});
