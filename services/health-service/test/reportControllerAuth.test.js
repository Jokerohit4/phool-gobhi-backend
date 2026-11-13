import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { requireAuth } from '../middleware/requireAuth.js';

const calls = [];
const capture = (name, result) => async (input) => { calls.push([name, input]); return result; };
mock.module('../services/reportService.js', { namedExports: {
  createReportService: capture('create', { id: 42, fileName: 'demo.pdf', status: 'PENDING' }),
  processReportService: capture('process', {}),
  getPendingExtractionsService: capture('pending', []),
  verifyExtractionService: capture('verify', { message: 'Verified' }),
  listReportsService: capture('list', []),
  deleteReportService: capture('delete', { deleted: true }),
} });
mock.module('../services/ledger/medicalDocumentStorage.js', { namedExports: {
  isAllowedReportMimeType: () => true,
  saveDocument: capture('store', 'medical/7/demo.pdf'),
} });
const controller = await import('../controllers/reportController.js');

function request() {
  const req = {
    headers: { 'x-user-id': '7', 'x-user-role': 'customer' },
    body: { userId: 999, extractionId: 42, confirmedValue: 5.4 },
    params: { id: '42' },
    file: { buffer: Buffer.from('demo'), mimetype: 'application/pdf', originalname: 'demo.pdf' },
  };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  requireAuth(req, res, () => {});
  return { req, res };
}

for (const [handler, service] of [['listReports', 'list'], ['getPendingExtractions', 'pending']]) {
  test(`${handler} uses the identity set by the real auth middleware`, async () => {
    calls.length = 0;
    const { req, res } = request();
    await controller[handler](req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [[service, 7]]);
  });
}

test('upload ownership comes from auth, not a userId in the form', async () => {
  calls.length = 0;
  const { req, res } = request();
  await controller.uploadReport(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(calls.find(([name]) => name === 'create')[1].userId, 7);
  assert.equal(calls.find(([name]) => name === 'store')[1].userId, 7);
});

test('verification uses the authenticated owner', async () => {
  calls.length = 0;
  const { req, res } = request();
  await controller.verifyExtraction(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [['verify', { extractionId: 42, userId: 7, confirmedValue: 5.4 }]]);
});

test('deletion uses the authenticated owner', async () => {
  calls.length = 0;
  const { req, res } = request();
  await controller.deleteReport(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [['delete', { reportId: '42', userId: 7 }]]);
});
