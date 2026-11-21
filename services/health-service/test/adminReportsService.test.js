import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let service, snapshots, documents, lookupFails, signedPaths;
const matches = (row, where) => Object.entries(where).every(([key, value]) => key === 'id' && typeof value === 'object' ? row.id < value.lt : row[key] === value);
const model = rows => ({
  findMany: async ({ where, take }) => rows().filter(row => matches(row, where)).sort((a, b) => b.id - a.id).slice(0, take),
  count: async ({ where }) => rows().filter(row => matches(row, where)).length,
  findUnique: async ({ where }) => rows().find(row => row.id === where.id) || null,
});
before(async t => {
  t.mock.module('../db/prisma.js', { exports: { default: { healthReport: model(() => snapshots), medicalDocument: model(() => documents) } } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { post: async (_url, body) => {
    if (lookupFails) throw new Error('auth unavailable');
    return { data: { data: body.ids.map(id => ({ id, name: `Account ${id}`, phone: `phone-${id}` })) } };
  } } } });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', { exports: { signedDocumentUrl: async path => { signedPaths.push(path); return 'https://private.example/short-lived'; } } });
  service = await import('../services/adminReportsService.js');
});
function reset() {
  lookupFails = false;signedPaths = [];
  snapshots = Array.from({ length: 57 }, (_, i) => ({ id: i + 1, userId: i % 2 ? 7 : 8, fileName: `report-${i + 1}.pdf`, storagePath: `private/${i + 1}`, status: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'][i % 4], createdAt: new Date(), proposedProfile: { name: 'Unconfirmed patient' } }));
  documents = [{ id: 1, userId: 9, title: 'Old saved blood report', kind: 'lab_report', storagePath: 'private/lab' }, { id: 2, userId: 9, title: 'Prescription', kind: 'prescription', storagePath: 'private/prescription' }];
}
test('all saved snapshots are listed without a paid or confirmation filter; older pages are reachable', async () => {
  reset();
  const first = await service.listAdminReports();
  assert.equal(first.total, 57);assert.equal(first.reports.length, 50);assert.equal(first.nextCursor, 8);
  assert.deepEqual(new Set(first.reports.map(row => row.status)), new Set(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']));
  assert.equal(first.reports[0].userName, 'Account 8');
  assert.ok(first.reports.every(row => !('storagePath' in row) && !('url' in row)));
  assert.equal(signedPaths.length, 0);
  const older = await service.listAdminReports({ cursor: String(first.nextCursor) });
  assert.equal(older.reports.length, 7);assert.equal(older.nextCursor, null);
  assert.equal(new Set([...first.reports, ...older.reports].map(row => row.id)).size, 57);
});
test('customer and processing filters retain failed files and reject bad cursors', async () => {
  reset();
  const page = await service.listAdminReports({ userId: '7', status: 'FAILED' });
  assert.ok(page.reports.length > 0);
  assert.ok(page.reports.every(row => row.userId === 7 && row.status === 'FAILED'));
  for (const query of [{ userId: '-1' }, { cursor: '1e2' }, { status: 'ACTIVE' }, { source: 'anything' }]) await assert.rejects(service.listAdminReports(query), { status: 400 });
});
test('saved medical lab reports appear independently of OCR and account-service availability', async () => {
  reset();lookupFails = true;
  const page = await service.listAdminReports({ source: 'document' });
  assert.equal(page.total, 1);assert.equal(page.reports[0].status, 'SAVED');
  assert.equal(page.reports[0].fileName, 'Old saved blood report');
  assert.equal(page.accountLookupUnavailable, true);
  assert.equal(page.reports[0].userName, null);
});
test('private links are generated on demand and stay scoped to actual saved reports', async () => {
  reset();
  assert.equal((await service.adminReportLink('snapshot', '1')).url, 'https://private.example/short-lived');
  assert.equal((await service.adminReportLink('document', '1')).url, 'https://private.example/short-lived');
  assert.deepEqual(signedPaths, ['private/1', 'private/lab']);
  await assert.rejects(service.adminReportLink('document', '2'), { status: 404 });
  await assert.rejects(service.adminReportLink('snapshot', '999'), { status: 404 });
  await assert.rejects(service.adminReportLink('snapshot', '0'), { status: 400 });
});
