import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let createReport, deleteReport, processReport, profile, report, rows, read, calls, analyticsFailure;
const match = where => Object.entries(where).every(([k, v]) => report[k] === v);
before(async t => {
  const db = {
    healthReport: {
      create: async ({ data }) => report = { ...report, ...data },
      findFirst: async ({ where }) => match(where) ? { ...report } : null,
      findUnique: async () => ({ ...report }),
      update: async ({ data }) => Object.assign(report, data),
      updateMany: async ({ where, data }) => { if (!match(where)) return { count: 0 };Object.assign(report, data);return { count: 1 }; },
      deleteMany: async ({ where }) => { if (match(where)) report = null; },
    },
    guidanceProfile: {
      findUnique: async () => profile,
      upsert: async ({ create, update }) => profile = profile ? { ...profile, ...update } : create,
      updateMany: async ({ where, data }) => {
        if (profile?.sourceReportId === where.sourceReportId) profile = { ...profile, ...data };
      },
    },
    reportExtraction: {
      findMany: async () => rows.filter(r => r.isVerified),
      deleteMany: async () => { rows = rows.filter(r => r.isVerified); },
      createMany: async ({ data }) => { rows.push(...data); },
    },
  };
  db.$transaction = async fn => fn(db);
  db.$executeRaw = async () => {};
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/analytics.js', { exports: { track: () => { if (analyticsFailure) throw new Error('analytics unavailable'); } } });
  t.mock.module('../utils/ocrService.js', { exports: { extractBiomarkersFromPDF: async (...args) => { calls++;return read(...args); } } });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', { exports: { signedDocumentUrl: async () => 'https://private.example/signed', deleteObjects: async () => ({ failed: [] }) } });
  t.mock.module('../services/ledger/blendedScoreCache.js', { exports: { invalidateBlendedScore: async () => {} } });
  ({ createReportService: createReport, deleteReportService: deleteReport, processReportService: processReport } = await import('../services/reportService.js'));
});
function reset() {
  report = { id: 1, userId: 7, storagePath: 'medical/7/private', status: 'PENDING', reportDate: null, processingToken: null };
  rows = [];calls = 0;
  profile = null;
  analyticsFailure = false;
  read = async () => ({ profile: { name: 'Patient', age: 31 }, markers: {}, detectedDate: { date: '2026-11-01' }, extractions: [{ metric: 'hba1c', rawValue: 'HbA1c 7.1 %', normalizedValue: 7.1, unit: '%', confidence: 0.9 }] });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('storing an upload sets an unanswered or negative condition even if telemetry fails', async () => {
  for (const hasCondition of [null, false]) {
    reset();
    if (hasCondition !== null) profile = { userId: 7, hasCondition, conditionSource: 'self_declared' };
    analyticsFailure = true;
    const readConsentAt = new Date();
    const stored = await createReport({ userId: 7, storagePath: 'medical/7/private', fileName: 'lab.pdf', readConsentAt });
    assert.equal(stored.readConsentAt, readConsentAt);
    assert.equal(profile.hasCondition, true);
    assert.equal(profile.conditionSource, 'report');
    assert.equal(profile.conditionType, null);
    assert.ok(profile.conditionDeclaredAt instanceof Date);
  }
});
test('storing a report keeps an existing true answer, and deleting a report detaches its clinical details', async () => {
  reset();
  const answer = { userId: 7, hasCondition: true, conditionSource: 'self_declared', conditionType: 'diabetes', conditionDeclaredAt: new Date(), region: 'GURUGRAM' };
  profile = { ...answer, sourceReportId: 1, confirmedMarkers: { hba1c: 6.4 }, clinicalStatus: 'CLEARED' };
  const previous = profile;
  await createReport({ userId: 7, storagePath: 'medical/7/private', fileName: 'lab.pdf' });
  assert.deepEqual(profile, previous);
  await deleteReport({ userId: 7, reportId: 1 });
  assert.equal(profile.sourceReportId, null);
  assert.deepEqual(profile.confirmedMarkers, {});
  assert.equal(profile.clinicalStatus, 'PENDING');
  assert.deepEqual(Object.fromEntries(Object.keys(answer).map(key => [key, profile[key]])), answer);
  assert.equal(report, null);
});
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
test('readings are persisted while earlier user-confirmed readings survive re-reading', async () => {
  reset();
  const confirmed = [{ label: 'Glucose', value: '80', unit: 'mg/dL' }];
  const proposed = [{ label: 'Glucose', value: '90', unit: 'mg/dL' }];
  report.confirmedReadings = confirmed;
  read = async () => ({ profile: {}, markers: {}, extractions: [], readings: proposed });
  assert.equal((await processReport(1)).status, 'COMPLETED');
  assert.deepEqual(report.proposedReadings, proposed);
  assert.deepEqual(report.confirmedReadings, confirmed);
  assert.deepEqual(rows, []);
});
test('reader failure stays retryable and does not modify a user-supplied report date', async () => {
  reset();read = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(processReport(1));assert.equal(report.status, 'FAILED');
  report.status = 'PENDING';report.reportDate = '2026-10-01';
  read = async () => ({ profile: {}, markers: {}, extractions: [], detectedDate: { date: '2026-11-01' } });
  await processReport(1);assert.equal(report.reportDate, '2026-10-01');assert.equal(report.detectedReportDate, undefined);
});
