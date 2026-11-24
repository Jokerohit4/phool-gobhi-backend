import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// A long report is the case the single online call refuses. The reader must fall
// back to the first and last windows, merge them, and pay for nothing extra on a
// report that fits.

let extract, mergeParsed, restoreFetch;
before(async t => {
  process.env.GOOGLE_PROJECT_ID = 'test-project';
  process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID = 'test-processor';
  t.mock.module('google-auth-library', { exports: { GoogleAuth: class { async getAccessToken() { return 'token'; } } } });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('%PDF-1.4') });
  restoreFetch = () => { globalThis.fetch = original; };
  ({ extractBiomarkersFromPDF: extract, mergeParsed } = await import('../utils/ocrService.js'));
});
import { after } from 'node:test';
after(() => restoreFetch?.());

const doc = text => ({ document: { text, pages: [] } });
const pageLimit = () => Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: { message: 'Document pages exceed the limit: 15 got 22' } } } });

test('a report that fits is one call', async () => {
  const calls = [];
  const post = async (_url, body) => { calls.push(body); return { data: doc('HbA1c 5.8 %\n') }; };
  const out = await extract('https://signed.example/r.pdf', 'application/pdf', { post, env: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].processOptions, undefined);
  assert.equal(out.extractions.find(ex => ex.metric === 'hba1c').normalizedValue, 5.8);
});

test('a page-limit refusal falls back to the first and last windows and merges them', async () => {
  const calls = [];
  const post = async (_url, body) => {
    calls.push(body.processOptions ?? null);
    if (!body.processOptions) throw pageLimit();
    // Both windows see the shared middle pages, so HbA1c comes back twice.
    return { data: doc(body.processOptions.fromStart ? 'HbA1c 5.8 %\nLDL Cholesterol 131 mg/dL\n' : 'HbA1c 5.8 %\nTriglycerides 140 mg/dL\n') };
  };
  const out = await extract('https://signed.example/r.pdf', 'application/pdf', { post, env: {} });
  assert.deepEqual(calls, [null, { fromStart: 15 }, { fromEnd: 15 }]);
  assert.deepEqual(out.extractions.map(ex => ex.metric).sort(), ['hba1c', 'ldl', 'triglycerides']);
});

test('any other refusal is not retried as windows', async () => {
  let n = 0;
  const post = async () => { n++; throw Object.assign(new Error('bad'), { response: { status: 400, data: { error: { message: 'Invalid document' } } } }); };
  await assert.rejects(() => extract('https://signed.example/r.pdf', 'application/pdf', { post, env: {} }));
  assert.equal(n, 1);
});

test('merging keeps one of each overlapping reading and the most confident extraction', () => {
  const a = { extractions: [{ metric: 'hba1c', confidence: 0.5, normalizedValue: 5.8 }], readings: [{ label: 'Glucose', value: '92', unit: 'mg/dL' }], detectedDate: { date: '2026-03-04', confidence: 0.6 }, profile: { name: 'A', age: null }, markers: { sgpt: 30 } };
  const b = { extractions: [{ metric: 'hba1c', confidence: 0.9, normalizedValue: 5.9 }], readings: [{ label: 'GLUCOSE', value: '92', unit: 'mg/dL ' }, { label: 'Urea', value: '28' }], detectedDate: { date: '2026-03-03', confidence: 0.95 }, profile: { name: 'B', age: 31 }, markers: { sgpt: 99, sgot: 20 } };
  const out = mergeParsed([a, b]);
  assert.equal(out.extractions[0].normalizedValue, 5.9);
  assert.deepEqual(out.readings.map(r => r.label), ['Glucose', 'Urea']);
  assert.equal(out.detectedDate.date, '2026-03-03');
  assert.deepEqual(out.profile, { name: 'A', age: 31, gender: null, address: null });
  assert.deepEqual(out.markers, { sgpt: 30, sgot: 20 });
});
