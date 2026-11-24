import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Route-level behaviour added with the report-reading rework: identical
// re-uploads are answered from the existing report, over-long PDFs are refused
// before a paid read, confirming settles every extracted value from the
// reviewed readings, and the list endpoint no longer carries readings.

let server, base;
let stored = [], created = [], upserts = [], deleted = [], extractionUpdates = [], profile = null;
let existingBySha = null, selectUsed = null;
const state = { sha: null };

const report = {
  id: 1, userId: 7, fileName: 'panel.pdf', storagePath: 'private/7/panel', status: 'COMPLETED', createdAt: new Date('2026-11-01'),
  updatedAt: new Date('2026-11-01'), reportDate: null, detectedReportDate: null, failureCode: null,
  proposedProfile: { name: 'Patient' },
  proposedReadings: [
    { label: 'HbA1c', value: '5.2', unit: '%' },
    { label: 'LDL Cholesterol', value: '2.6', unit: 'mmol/L' },
    { label: 'HDL Cholesterol', value: '45', unit: 'mg/dL' },
    { label: 'SGPT (ALT)', value: '55', unit: 'U/L' },
  ],
  confirmedReadings: null,
  extractions: [
    { id: 11, metric: 'hba1c', normalizedValue: 5.2, unit: '%', isVerified: false },
    { id: 12, metric: 'ldl', normalizedValue: 100, unit: 'mg/dL', isVerified: false },
    { id: 13, metric: 'hdl', normalizedValue: 45, unit: 'mg/dL', isVerified: false },
  ],
};

const db = {
  healthReport: {
    findFirst: async ({ where }) => (where.userId === 7 && where.id === 1 ? report : null),
    findMany: async args => { selectUsed = args.select ?? null; return [{ ...report, status: 'FAILED', failureCode: 'TOO_LONG' }]; },
    update: async ({ data }) => Object.assign(report, data),
    updateMany: async () => ({ count: 1 }),
  },
  guidanceProfile: {
    findUnique: async () => profile,
    upsert: async ({ create, update }) => (profile = profile ? { ...profile, ...update } : create),
  },
  guidanceRequest: { findMany: async () => [] },
  reportExtraction: {
    update: async ({ where, data }) => { extractionUpdates.push([where.id, data]); return {}; },
    delete: async ({ where }) => { deleted.push(where.id); return {}; },
  },
  biometricEntry: { upsert: async ({ create }) => { upserts.push([create.metric, create.value]); } },
};
db.$transaction = async fn => fn(db);

before(async t => {
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../middleware/requireFeatureFlag.js', { exports: { requireFeatureFlag: () => (_req, _res, next) => next() } });
  t.mock.module('../services/reportService.js', { exports: {
    createReportService: async input => { created.push(input); return { id: 1 }; },
    processReportService: async () => {},
    parseReportDate: value => value || null,
    findExistingReport: async (_user, sha) => { state.sha = sha; return existingBySha?.sha === sha ? existingBySha.row : null; },
  } });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', { exports: {
    MAX_UPLOAD_BYTES: 10485760, isAllowedMimeType: () => true, isAllowedReportMimeType: () => true,
    saveDocument: async ({ buffer }) => { stored.push(buffer.length); return 'private/7/new'; },
    signedDocumentUrl: async () => 'https://private.example/signed', deleteObjects: async () => ({ failed: [] }),
  } });
  t.mock.module('../services/ledger/blendedScoreCache.js', { exports: { invalidateBlendedScore: async () => {} } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: { data: {} } }) } } });
  const router = (await import('../routes/guidance.js')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

const headers = { 'x-user-id': '7', 'x-user-role': 'customer' };
const json = async (path, body) => {
  const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};
const upload = async bytes => {
  const form = new FormData();
  form.set('readConsent', 'true');
  form.set('file', new Blob([bytes], { type: 'application/pdf' }), 'panel.pdf');
  const res = await fetch(`${base}/guidance/reports`, { method: 'POST', headers, body: form });
  return { status: res.status, body: await res.json() };
};
const pdf = pages => Buffer.from(`%PDF-1.4\n${'<< /Type /Page >>\n'.repeat(pages)}%%EOF`);

test('the same file uploaded again is answered from the existing report with no storage write or read', async () => {
  const first = await upload(pdf(2));
  assert.equal(first.status, 200);
  assert.equal(created.length, 1);
  assert.match(created[0].fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.length, 1);

  existingBySha = { sha: created[0].fileSha256, row: { id: 1 } };
  const again = await upload(pdf(2));
  assert.equal(again.status, 200);
  assert.equal(again.body.data.id, 1);
  assert.equal(created.length, 1, 'no second report row');
  assert.equal(stored.length, 1, 'no second storage write');
  existingBySha = null;
});

test('a PDF that is plainly too long is refused before any storage write', async () => {
  const before = stored.length;
  const res = await upload(pdf(41));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /more than 40 pages/);
  assert.equal(stored.length, before);
});

test('confirming settles every value from the reviewed readings, keeps what was kept, drops what was removed', async () => {
  // The person removed the HDL row and left the markers form empty.
  const result = await json('/guidance/reports/1/confirm', {
    belongsToMe: true,
    details: {},
    markers: {},
    readings: report.proposedReadings.filter(row => !/HDL/.test(row.label)),
    liverFlag: false,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(upserts.sort(), [['hba1c', 5.2], ['ldl', 100.54]].sort());
  assert.deepEqual(deleted, [13], 'the removed HDL extraction is dropped, not left unconfirmed');
  // Typed values were filled from the readings, and the raised SGPT is amber at least.
  assert.equal(profile.confirmedMarkers.hba1c, 5.2);
  assert.equal(profile.confirmedMarkers.sgpt, 55);
  assert.equal(profile.riskBucket, 'AMBER');
});

test('the list carries a summary row, not readings, and a failed report says why', async () => {
  const result = await json('/guidance/me');
  assert.equal(result.status, 200);
  const [row] = result.body.data.reports;
  assert.equal(row.failureCode, 'TOO_LONG');
  assert.equal(row.stalled, false);
  assert.equal(Object.hasOwn(row, 'proposedReadings'), false);
  assert.equal(Object.hasOwn(row, 'confirmedReadings'), false);
  assert.ok(selectUsed && !('proposedReadings' in selectUsed), 'the query must not select the readings');
});

test('typed markers are proposed from the readings when the extractor found none', async () => {
  const view = await json('/guidance/reports/1');
  assert.equal(view.body.data.proposedMarkers.sgpt, 55);
  assert.equal(view.body.data.failureCode, null);
});
