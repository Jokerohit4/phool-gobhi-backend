import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countResultCandidates, needsModel, redactForModel, groundRows, mergeReadings, parseModelRows,
  structureWithModel, enrichParsedReport, fillFromReadings, modelConfig, resetBudgetForTests,
} from '../utils/reportLlm.js';

const rows = [
  'Hemoglobin 13.5 g/dL 13-17', 'Total WBC Count 7200 /cumm 4000-11000', 'Platelet Count 250000 /cumm 150000-410000',
  'Glucose Fasting 92 mg/dL 70-100', 'Creatinine 0.9 mg/dL 0.6-1.2', 'Uric Acid 5.1 mg/dL 3.5-7.2',
  'LDL Cholesterol 131 mg/dL <100', 'HDL Cholesterol 45 mg/dL >40',
];
const text = rows.join('\n');
const env = { REPORT_LLM_ENABLED: 'true', ASSISTANT_PROVIDER_BASE_URL: 'https://llm.example/v1/', ASSISTANT_PROVIDER_API_KEY: 'k', ASSISTANT_PROVIDER_MODEL: 'm' };
const reply = payload => ({ data: { choices: [{ message: { content: payload } }] } });

test('the model is only used when the text suggests far more rows than were read', () => {
  assert.equal(countResultCandidates(text), 8);
  assert.equal(needsModel({ readings: [], text }), true);
  assert.equal(needsModel({ readings: new Array(4), text }), true);
  assert.equal(needsModel({ readings: new Array(5), text }), false, 'five of eight is enough: no call, no cost');
  assert.equal(needsModel({ readings: [], text: 'Hemoglobin 13.5\nGlucose 92' }), false, 'too little text to bother');
  assert.equal(needsModel({ readings: [], text: `${'Narrative sentence with no results in it at all. '.repeat(8)}` }), false);
});

test('nothing that identifies the patient is sent', () => {
  const report = [
    'Patient Name: Priya Mehta', 'Age/Sex: 31 / F', 'Mobile: 9876543210', 'Priya.Mehta@example.com',
    'Sample ID 2026112012345678', 'Collected at Indiranagar Branch for Priya Mehta', 'Dr. Rahul Sharma MD',
    'Home: 14 Indiranagar Main Road', ...rows,
  ].join('\n');
  const sent = redactForModel(report, { name: 'Priya Mehta', address: '14 Indiranagar Main Road' });
  for (const secret of ['Priya', 'Mehta', '9876543210', '@example.com', '2026112012345678', 'Rahul', 'Indiranagar']) {
    assert.equal(sent.includes(secret), false, `${secret} leaked`);
  }
  assert.match(sent, /Hemoglobin 13\.5 g\/dL/);
  assert.match(sent, /LDL Cholesterol 131/);
});

test('input is capped so one huge file cannot become a huge bill', () => {
  const big = Array.from({ length: 4000 }, (_, i) => `Test ${i} ${i}.5 mg/dL`).join('\n');
  assert.ok(redactForModel(big).length <= 12000);
});

test('a row the report does not support is dropped, however confident the model sounded', () => {
  const sent = ['Glucose Fasting', '92', 'mg/dL', 'LDL Cholesterol 131 mg/dL <100', 'Creatinine 0.9 mg/dL'].join('\n');
  const out = groundRows([
    { label: 'Glucose Fasting', value: '92', unit: 'mg/dL' },                  // value on the next line: grounded
    { label: 'LDL Cholesterol', value: '113', unit: 'mg/dL' },                 // digits swapped: not in the text
    { label: 'Creatinine', value: '0.9', unit: 'g/dL', flag: 'H' },            // row kept, unprinted unit and flag dropped
    { label: 'Vitamin D', value: '92' },                                       // label not in the text at all
    { label: 'Patient Name', value: '92' },                                    // identity row
    { label: 'Glucose Fasting', value: '92', unit: 'mg/dL' },                  // duplicate
    null, { label: 'x', value: 5 }, 'nonsense',
  ], sent);
  assert.deepEqual(out, [
    { label: 'Glucose Fasting', value: '92', unit: 'mg/dL' },
    { label: 'Creatinine', value: '0.9' },
  ]);
});

test('a value on a different row is not evidence for a label', () => {
  // "5" exists in the text, but not on or just after the Uric Acid line.
  const sent = ['Uric Acid', 'Not detected', 'Glucose 5 mg/dL', 'Sodium', 'Potassium', 'Chloride'].join('\n');
  assert.deepEqual(groundRows([{ label: 'Uric Acid', value: '5' }], sent), []);
});

test('model rows are added, never replace what the deterministic reader found', () => {
  const base = [{ label: 'Hemoglobin', value: '13.5', unit: 'g/dL' }];
  const merged = mergeReadings(base, [{ label: 'Hemoglobin (Hb)', value: '13.5' }, { label: 'Creatinine', value: '0.9' }]);
  assert.deepEqual(merged, [base[0], { label: 'Creatinine', value: '0.9' }]);
});

test('model output is parsed tolerantly and bad output is an empty answer', () => {
  assert.deepEqual(parseModelRows('```json\n{"rows":[{"label":"A","value":"1"}]}\n```'), [{ label: 'A', value: '1' }]);
  assert.deepEqual(parseModelRows('Sorry, I cannot help'), []);
  assert.deepEqual(parseModelRows('{"rows": "no"}'), []);
  assert.deepEqual(parseModelRows('{ broken'), []);
});

test('disabled or unconfigured means no call at all', async () => {
  let calls = 0;
  const post = async () => { calls++; return reply('{}'); };
  assert.equal(modelConfig({}), null);
  assert.equal(modelConfig({ ...env, REPORT_LLM_ENABLED: 'false' }), null);
  assert.equal(modelConfig({ ...env, ASSISTANT_PROVIDER_API_KEY: '' }), null);
  assert.deepEqual(await structureWithModel(text, {}, { post, env: {} }), []);
  assert.equal(calls, 0);
});

test('a grounded answer comes back; a provider failure is swallowed; the daily cap holds', async () => {
  resetBudgetForTests();
  const good = async (url, body, options) => {
    assert.equal(url, 'https://llm.example/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer k');
    assert.equal(body.temperature, 0);
    assert.equal(body.messages[1].content.includes('Priya'), false);
    return reply(JSON.stringify({ rows: [{ label: 'Creatinine', value: '0.9', unit: 'mg/dL' }, { label: 'Creatinine', value: '9.9' }] }));
  };
  assert.deepEqual(await structureWithModel(`Patient Name: Priya\n${text}`, { name: 'Priya' }, { post: good, env }), [{ label: 'Creatinine', value: '0.9', unit: 'mg/dL' }]);

  const boom = async () => { throw Object.assign(new Error('provider echoed the document'), { response: { data: 'Hemoglobin 13.5' } }); };
  assert.deepEqual(await structureWithModel(text, {}, { post: boom, env }), []);

  resetBudgetForTests();
  let calls = 0;
  const counted = async () => { calls++; return reply('{"rows":[]}'); };
  const capped = { ...env, REPORT_LLM_DAILY_CAP: '2' };
  for (let i = 0; i < 5; i++) await structureWithModel(text, {}, { post: counted, env: capped });
  assert.equal(calls, 2);
  resetBudgetForTests();
});

test('typed values come from the readings: lipids in any unit, liver enzymes, and no duplicates', () => {
  const out = fillFromReadings({
    extractions: [{ metric: 'hba1c', rawValue: 'HbA1c 5.8 %', normalizedValue: 5.8, unit: '%', confidence: 0.9 }],
    readings: [
      { label: 'HbA1c', value: '9.9', unit: '%' },
      { label: 'LDL Cholesterol', value: '2.6', unit: 'mmol/L' },
      { label: 'HDL Cholesterol', value: '45', unit: 'mg/dL' },
      { label: 'SGPT (ALT)', value: '55', unit: 'U/L' },
    ],
    markers: { systolic: 120 },
  });
  assert.deepEqual(out.extractions.map(ex => [ex.metric, ex.normalizedValue, ex.confidence]), [['hba1c', 5.8, 0.9], ['hdl', 45, 0], ['ldl', 100.54, 0]]);
  assert.deepEqual(out.markers, { systolic: 120, sgpt: 55 });
});

test('enrichment calls the model only for a thin read, and keeps the deterministic rows', async () => {
  resetBudgetForTests();
  let calls = 0;
  const post = async () => { calls++; return reply(JSON.stringify({ rows: [{ label: 'Creatinine', value: '0.9', unit: 'mg/dL' }] })); };

  const full = { readings: rows.map((row, i) => ({ label: `Test ${i}`, value: String(i) })), extractions: [], markers: {}, profile: {} };
  await enrichParsedReport(full, text, { post, env });
  assert.equal(calls, 0, 'a complete read never reaches the model');

  const thin = { readings: [{ label: 'Hemoglobin', value: '13.5', unit: 'g/dL' }], extractions: [], markers: {}, profile: {} };
  const out = await enrichParsedReport(thin, text, { post, env });
  assert.equal(calls, 1);
  assert.deepEqual(out.readings, [thin.readings[0], { label: 'Creatinine', value: '0.9', unit: 'mg/dL' }]);
  resetBudgetForTests();
});
