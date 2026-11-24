import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let server, base, profile = null, writtenBiometrics = 0, entitlement = { isGuided: false }, requests = [];
let reads = 0;
const report = { id: 1, userId: 7, fileName: 'report.pdf', storagePath: 'private/7/report', status: 'COMPLETED', createdAt: new Date('2026-11-01'), reportDate: null, proposedProfile: { name: 'Patient' }, extractions: [{ id: 11, metric: 'hba1c', normalizedValue: 7.1 }] };
const db = {
  healthReport: {
    findFirst: async ({ where }) => where.userId === 7 && where.id === 1 ? report : null,
    update: async ({ data }) => Object.assign(report, data),
    updateMany: async ({ where, data }) => {
      if (Object.entries(where).some(([key, value]) => report[key] !== value)) return { count: 0 };
      Object.assign(report, data);
      return { count: 1 };
    },
  },
  guidanceProfile: {
    findUnique: async () => profile,
    upsert: async ({ create, update }) => profile = profile ? { ...profile, ...update } : create,
    updateMany: async ({ where, data }) => { if (!profile || where.sourceReportId !== profile.sourceReportId || +where.confirmedAt !== +profile.confirmedAt) return { count: 0 }; Object.assign(profile, data); return { count: 1 }; },
  },
  reportExtraction: { update: async () => ({}), delete: async () => ({}) },
  biometricEntry: { upsert: async () => { writtenBiometrics++; } },
  guidanceRequest: { findFirst: async () => requests[0], create: async ({ data }) => { const row = { id: requests.length + 1, ...data };requests.push(row);return row; } },
};
db.$transaction = async fn => fn(db);
before(async t => {
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../middleware/requireFeatureFlag.js', { exports: { requireFeatureFlag: () => (_req, _res, next) => next() } });
  t.mock.module('../services/reportService.js', { exports: {
    createReportService: async () => report,
    processReportService: async () => {
      reads++;
      Object.assign(report, { status: 'COMPLETED', proposedReadings: [{ label: 'Glucose', value: 'Negative' }] });
    },
    parseReportDate: value => value || null,
    findExistingReport: async () => null,
  } });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', { exports: { MAX_UPLOAD_BYTES: 10485760, isAllowedMimeType: () => true, isAllowedReportMimeType: () => true, saveDocument: async () => '', signedDocumentUrl: async () => 'https://private.example/signed', deleteObjects: async () => ({ failed: [] }) } });
  t.mock.module('../services/ledger/blendedScoreCache.js', { exports: { invalidateBlendedScore: async () => {} } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: { data: entitlement } }) } } });
  const router = (await import('../routes/guidance.js')).default;
  const app = express();app.use(express.json());app.use(router);
  server = app.listen(0, '127.0.0.1');await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));
async function call(path, body, { role = 'customer', user = 7 } = {}) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-user-id': String(user), 'x-user-role': role, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const confirmation = { belongsToMe: true, details: { name: 'Priya', gender: 'female', age: 31, address: 'Indiranagar' }, markers: { hba1c: 7.1 }, liverFlag: false };
test('report reads are owner-bound and never expose storage capability', async () => {
  assert.equal((await call('/guidance/reports/1', undefined, { user: 8 })).status, 404);
  const own = await call('/guidance/reports/1');assert.equal(own.status, 200);assert.equal(Object.hasOwn(own.body.data, 'storagePath'), false);
});
test('the all-report library and saved-file links are staff-only', async () => {
  assert.equal((await call('/guidance/admin/reports')).status, 403);
  assert.equal((await call('/guidance/admin/reports/snapshot/1/link')).status, 403);
  assert.equal((await call('/guidance/admin/reports/document/1/link')).status, 403);
});
test('unconfirmed identity and invalid values never write health data', async () => {
  assert.equal((await call('/guidance/reports/1/confirm', { ...confirmation, belongsToMe: false })).status, 400);
  assert.equal((await call('/guidance/reports/1/confirm', { ...confirmation, markers: { hba1c: 'bad' } })).status, 400);
  assert.equal(profile, null);assert.equal(writtenBiometrics, 0);
});
test('confirmation stores explicit identity and verified markers without inventing DOB', async () => {
  const result = await call('/guidance/reports/1/confirm', confirmation);
  assert.equal(result.status, 200);assert.equal(profile.riskBucket, 'RED');assert.equal(profile.confirmedDetails.age, 31);assert.equal(profile.confirmedDetails.dateOfBirth, undefined);assert.equal(writtenBiometrics, 1);
});
test('customers cannot write clinical clearance; a named clinician and current report are required', async () => {
  const review = { sourceReportId: 1, confirmedAt: profile.confirmedAt.toISOString(), clinicianName: 'Reviewing clinician', clinicianRegistration: 'REG-TEST', clinicalNote: 'Recorded external signed review', clinicalStatus: 'CLEARED', agreedActions: ['Follow the agreed routine'], attestReviewed: true };
  assert.equal((await call('/guidance/admin/7/review', review)).status, 403);
  assert.equal((await call('/guidance/admin/7/review', { ...review, sourceReportId: 2 }, { role: 'gobhi' })).status, 400);
  assert.equal((await call('/guidance/admin/7/review', { ...review, clinicianRegistration: '' }, { role: 'gobhi' })).status, 400);
  assert.equal((await call('/guidance/admin/7/review', { ...review, confirmedAt: '2020-01-01' }, { role: 'gobhi' })).status, 400);
  assert.equal((await call('/guidance/admin/7/review', review, { role: 'gobhi' })).status, 200);
  assert.equal(profile.clinicalStatus, 'CLEARED');
});
test('replaying identical confirmation keeps clinical notes; changed markers reset clearance', async () => {
  await call('/guidance/reports/1/confirm', confirmation);assert.equal(profile.clinicalStatus, 'CLEARED');
  await call('/guidance/reports/1/confirm', { ...confirmation, markers: { hba1c: 7.5 } });
  assert.equal(profile.clinicalStatus, 'PENDING');assert.equal(profile.clinicalNote, null);
});
test('paid request gates do not gate report reads; form support requires clearance', async () => {
  assert.equal((await call('/guidance/requests', { kind: 'COACH_CALL' })).status, 403);
  assert.equal((await call('/guidance/reports/1')).status, 200);
  entitlement = { isGuided: true, plan_type: 'QUARTERLY_11999', free_delight_sessions_remaining: 2, addon_trainer_sessions_remaining: 0 };
  assert.equal((await call('/guidance/requests', { kind: 'FORM_SESSION' })).status, 400);
  assert.equal((await call('/guidance/requests', { kind: 'DOCTOR_CALL' })).status, 200);
  assert.equal((await call('/guidance/requests', { kind: 'DOCTOR_CALL' })).status, 200);
  assert.equal(requests.length, 1);
});
test('remote guidance cannot request floor sessions even if an old balance remains', async () => {
  entitlement = { isGuided: true, plan_type: 'QUARTERLY_11999', benefits: { trainerFloorSessions: false }, free_delight_sessions_remaining: 2, addon_trainer_sessions_remaining: 4 };
  assert.equal((await call('/guidance/requests', { kind: 'FORM_SESSION' })).status, 400);
  assert.equal((await call('/guidance/requests', { kind: 'COACH_CALL' })).status, 200);
});
test('clinical and coaching requests follow purchased inclusions rather than a tier name', async () => {
  entitlement = { isGuided: true, plan_type: 'MONTHLY_4499', offer: { dietitianReview: true, doctorClearanceForRed: false, weeklyCoaching: false } };
  assert.equal((await call('/guidance/requests', { kind: 'DIETITIAN_REVIEW' })).status, 200);
  assert.equal((await call('/guidance/requests', { kind: 'DOCTOR_CALL' })).status, 400);
  assert.equal((await call('/guidance/requests', { kind: 'COACH_CALL' })).status, 400);
});
test('only staff can open another customer’s confirmed source for clinical review', async () => {
  assert.equal((await call('/guidance/admin/7/report-link')).status, 403);
  const result = await call('/guidance/admin/7/report-link', undefined, { role: 'gobhi' });
  assert.equal(result.status, 200);assert.equal(result.body.data.url, 'https://private.example/signed');
});
test('an arbitrary reading is editable and persists on the report across old clients', async () => {
  const readings = [{ label: 'Bilirubin', value: '<0.2', unit: 'mg/dL', referenceRange: '0–0.3' }];
  assert.equal((await call('/guidance/reports/1/confirm', { ...confirmation, readings }, { user: 8 })).status, 404);
  assert.equal((await call('/guidance/reports/1/confirm', { ...confirmation, readings: [{ label: 'Bilirubin', value: 0.2 }] })).status, 400);
  const saved = await call('/guidance/reports/1/confirm', { ...confirmation, readings });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.confirmedReadings, readings);
  assert.deepEqual((await call('/guidance/reports/1')).body.data.confirmedReadings, readings);
  await call('/guidance/reports/1/confirm', confirmation);
  assert.deepEqual(report.confirmedReadings, readings);
});
test('a saved report with reading consent can be re-read once for the new data', async () => {
  const confirmed = report.confirmedReadings;
  report.proposedReadings = null;
  assert.equal((await call('/guidance/reports/1')).body.data.canReadAgain, false);
  report.readConsentAt = new Date();
  assert.equal((await call('/guidance/reports/1')).body.data.canReadAgain, true);
  assert.equal((await call('/guidance/reports/1/retry', {}, { user: 8 })).status, 404);
  const reread = await call('/guidance/reports/1/retry', {});
  assert.equal(reread.status, 200);
  assert.equal(reread.body.data.canReadAgain, false);
  assert.deepEqual(reread.body.data.proposedReadings, [{ label: 'Glucose', value: 'Negative' }]);
  assert.deepEqual(reread.body.data.confirmedReadings, confirmed);
  assert.equal((await call('/guidance/reports/1/retry', {})).status, 200);
  assert.equal(reads, 1);
});
