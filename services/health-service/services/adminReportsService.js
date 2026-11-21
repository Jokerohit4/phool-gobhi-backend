import axios from 'axios';
import prisma from '../db/prisma.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { signedDocumentUrl } from './ledger/medicalDocumentStorage.js';

const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const sourceModel = source => {
  if (source === 'snapshot') return prisma.healthReport;
  if (source === 'document') return prisma.medicalDocument;
  invalid('Choose lab snapshots or saved lab reports');
};
function positive(value, label) {
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) invalid(`Invalid ${label}`);
  return Number(value);
}
export async function listAdminReports({ source = 'snapshot', cursor, userId, status } = {}) {
  const model = sourceModel(source), before = positive(cursor, 'page cursor'), owner = positive(userId, 'customer');
  if (status && !['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'].includes(status)) invalid('Invalid processing status');
  if (source === 'document' && status) invalid('Processing status applies to lab snapshots');
  const where = { ...(source === 'document' ? { kind: 'lab_report' } : {}), ...(owner ? { userId: owner } : {}), ...(status ? { status } : {}) };
  const select = source === 'snapshot'
    ? { id: true, userId: true, fileName: true, mimeType: true, status: true, createdAt: true, reportDate: true, detectedReportDate: true, processedAt: true, proposedProfile: true, proposedMarkers: true }
    : { id: true, userId: true, title: true, mimeType: true, kind: true, createdAt: true, docDate: true };
  const [rows, total] = await Promise.all([
    model.findMany({ where: { ...where, ...(before ? { id: { lt: before } } : {}) }, select, orderBy: { id: 'desc' }, take: 51 }),
    model.count({ where }),
  ]);
  const page = rows.slice(0, 50), users = new Map();
  let accountLookupUnavailable = false;
  if (page.length) {
    const url = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
    try {
      const response = await axios.post(`${url}/internal/users/batch`, { ids: [...new Set(page.map(r => r.userId))] }, { timeout: 10000, headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(url)) } });
      for (const user of response.data?.data || []) users.set(user.id, user);
    } catch { accountLookupUnavailable = true; }
  }
  return {
    source, total, accountLookupUnavailable,
    nextCursor: rows.length > 50 ? page.at(-1).id : null,
    reports: page.map(row => ({
      id: row.id, userId: row.userId, source,
      userName: users.get(row.userId)?.name || null, phone: users.get(row.userId)?.phone || null,
      fileName: row.fileName || row.title, mimeType: row.mimeType,
      status: source === 'snapshot' ? row.status : 'SAVED', createdAt: row.createdAt,
      reportDate: row.reportDate || row.docDate || null, detectedReportDate: row.detectedReportDate || null,
      processedAt: row.processedAt || null,
      proposedProfile: row.proposedProfile || {}, proposedMarkers: row.proposedMarkers || {},
    })),
  };
}
export async function adminReportLink(source, id) {
  const model = sourceModel(source), reportId = positive(id, 'report');
  if (!reportId) invalid('Invalid report');
  const row = await model.findUnique({ where: { id: reportId }, select: { storagePath: true, ...(source === 'document' ? { kind: true } : {}) } });
  if (!row || (source === 'document' && row.kind !== 'lab_report')) throw Object.assign(new Error('Report not found'), { status: 404 });
  return { url: await signedDocumentUrl(row.storagePath) };
}
