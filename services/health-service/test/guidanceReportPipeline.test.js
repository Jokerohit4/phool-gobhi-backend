import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let processReport, report, rows, read, calls;
const match = where => Object.entries(where).every(([k, v]) => report[k] === v);
before(async t => {
  const db = {
    healthReport: {
      findUnique: async () => ({ ...report }),
      update: async ({ data }) => Object.assign(report, data),
      updateMany: async ({ where, data }) => { if (!match(where)) return { count: 0 };Object.assign(report, data);return { count: 1 }; },
    },
    reportExtraction: {
      findMany: async () => rows.filter(r => r.isVerified),
      deleteMany: async () => { rows = rows.filter(r => r.isVerified); },
      createMany: async ({ data }) => { rows.push(...data); },
    },
  };
  db.$transaction = async fn => fn(db);
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/analytics.js', { exports: { track: () => {} } });
  t.mock.module('../utils/ocrService.js', { exports: { extractBiomarkersFromPDF: async (...args) => { calls++;return read(...args); } } });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', { exports: { signedDocumentUrl: async () => 'https://private.example/signed' } });
  t.mock.module('../services/ledger/blendedScoreCache.js', { exports: { invalidateBlendedScore: async () => {} } });
  processReport = (await import('../services/reportService.js')).processReportService;
});
function reset() {
  report = { id: 1, userId: 7, storagePath: 'medical/7/private', status: 'PENDING', reportDate: null, processingToken: null };
  rows = [];calls = 0;
  read = async () => ({ profile: { name: 'Patient', age: 31 }, markers: {}, detectedDate: { date: '2026-11-01' }, extractions: [{ metric: 'hba1c', rawValue: 'HbA1c 7.1 %', normalizedValue: 7.1, unit: '%', confidence: 0.9 }] });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('concurrent readers claim one attempt and create one pending extraction', async () => {
  reset();let release;const value = await read();read = () => new Promise(resolve => { release = () => resolve(value); });
  const first = processReport(1);while (!release) await tick();
  assert.equal((await processReport(1)).status, 'PROCESSING');
  release();assert.equal((await first).status, 'COMPLETED');assert.equal(calls, 1);assert.equal(rows.length, 1);assert.equal(report.detectedReportDate, '2026-11-01');
});
test('a superseded slow reader cannot overwrite a newer retry', async () => {
  reset();let release;const value = await read();
  read = () => calls === 1 ? new Promise(resolve => { release = () => resolve({ ...value, profile: { name: 'Old reading' } }); }) : Promise.resolve({ ...value, profile: { name: 'New reading' } });
  const first = processReport(1);while (!release) await tick();
  report.status = 'PENDING';report.processingToken = null;
  assert.equal((await processReport(1)).status, 'COMPLETED');release();
  assert.equal((await first).status, 'SUPERSEDED');assert.equal(report.proposedProfile.name, 'New reading');assert.equal(rows.length, 1);
});
test('identity-only extraction completes without manufacturing normal markers', async () => {
  reset();read = async () => ({ profile: { name: 'Patient' }, markers: {}, extractions: [] });
  assert.equal((await processReport(1)).status, 'COMPLETED');assert.equal(rows.length, 0);assert.deepEqual(report.proposedMarkers, {});
});
test('reader failure stays retryable and does not modify a user-supplied report date', async () => {
  reset();read = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(processReport(1));assert.equal(report.status, 'FAILED');
  report.status = 'PENDING';report.reportDate = '2026-10-01';
  read = async () => ({ profile: {}, markers: {}, extractions: [], detectedDate: { date: '2026-11-01' } });
  await processReport(1);assert.equal(report.reportDate, '2026-10-01');assert.equal(report.detectedReportDate, undefined);
});
