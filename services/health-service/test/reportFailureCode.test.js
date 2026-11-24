import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let service, report, sweeps, listed, read;
const match = where => Object.entries(where).every(([k, v]) => typeof v === 'object' && v !== null ? true : report[k] === v);

before(async t => {
  const db = {
    healthReport: {
      findUnique: async () => ({ ...report }),
      // Honour `select` the way the database does, so a field the query does not
      // ask for cannot appear in the result.
      findMany: async args => { listed = args; return [Object.fromEntries(Object.keys(args.select).map(key => [key, report[key]]))]; },
      findFirst: async () => report,
      update: async ({ data }) => Object.assign(report, data),
      updateMany: async ({ where, data }) => {
        if (where.userId !== undefined && where.status?.in) { sweeps.push({ where, data }); return { count: 0 }; }
        if (!match(where)) return { count: 0 };
        Object.assign(report, data);
        return { count: 1 };
      },
    },
    reportExtraction: { findMany: async () => [], deleteMany: async () => {}, createMany: async () => {} },
  };
  db.$transaction = async fn => fn(db);
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../utils/analytics.js', { exports: { track: () => {} } });
  t.mock.module('../utils/ocrService.js', { exports: { extractBiomarkersFromPDF: async (...args) => read(...args) } });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', { exports: { signedDocumentUrl: async () => 'https://private.example/signed' } });
  t.mock.module('../services/ledger/blendedScoreCache.js', { exports: { invalidateBlendedScore: async () => {} } });
  service = await import('../services/reportService.js');
});

const http = (status, message) => Object.assign(new Error('Request failed'), { response: { status, data: { error: { message } } } });
function reset() {
  report = { id: 1, userId: 7, storagePath: 'medical/7/private', status: 'PENDING', failureCode: null, reportDate: null, processingToken: null, extractions: [] };
  sweeps = [];
}

test('a failed read records why, and a retry clears it', async () => {
  reset();
  read = async () => { throw http(400, 'Document pages exceed the limit: 15 got 22'); };
  await assert.rejects(() => service.processReportService(1));
  assert.equal(report.status, 'FAILED');
  assert.equal(report.failureCode, 'TOO_LONG');

  report.status = 'PENDING';
  read = async () => ({ profile: {}, markers: {}, extractions: [], readings: [] });
  assert.equal((await service.processReportService(1)).status, 'COMPLETED');
  assert.equal(report.failureCode, null);
});

test('a reader that is rate limited is BUSY, and an unconfigured one is UNAVAILABLE', async () => {
  reset();
  read = async () => { throw http(429, 'Quota exceeded'); };
  await assert.rejects(() => service.processReportService(1));
  assert.equal(report.failureCode, 'BUSY');

  reset();
  read = async () => { throw new Error('OCR_CONFIG_MISSING'); };
  await assert.rejects(() => service.processReportService(1));
  assert.equal(report.failureCode, 'UNAVAILABLE');
});

test('listing sweeps reports whose reader died, and returns summary rows only', async () => {
  reset();
  report = { ...report, status: 'FAILED', failureCode: 'STALLED', fileName: 'a.pdf', createdAt: new Date(), updatedAt: new Date(), processingStartedAt: null, detectedReportDate: null, extractions: [{ isVerified: false }, { isVerified: true }] };
  const [row] = await service.listReportsService(7);
  assert.equal(sweeps.length, 1);
  assert.deepEqual(sweeps[0].where.status, { in: ['PENDING', 'PROCESSING'] });
  assert.equal(sweeps[0].data.status, 'FAILED');
  assert.equal(sweeps[0].data.failureCode, 'STALLED');
  assert.ok(sweeps[0].where.updatedAt.lt instanceof Date);
  assert.equal(row.failureCode, 'STALLED');
  assert.equal(row.extractionCount, 2);
  assert.equal(row.pendingCount, 1);
  assert.equal(row.stalled, false);
  for (const hidden of ['processingToken', 'proposedReadings', 'storagePath', 'fileSha256', 'extractions']) {
    assert.equal(Object.hasOwn(row, hidden), false, `${hidden} must not reach the device`);
  }
  assert.ok(listed.select && !('proposedReadings' in listed.select));
});
