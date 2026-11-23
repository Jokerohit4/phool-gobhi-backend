import { Router } from 'express';
import axios from 'axios';
import prisma from '../db/prisma.js';
import { requireAuth, requireRole, requireInternal } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { uploadMedicalDocumentMiddleware } from '../middleware/medicalUpload.js';
import { saveDocument, signedDocumentUrl, deleteObjects } from '../services/ledger/medicalDocumentStorage.js';
import { createReportService, processReportService, parseReportDate } from '../services/reportService.js';
import { validateMarkers, riskBucket } from '../utils/guidanceExtraction.js';
import { validateReportReadings } from '../utils/reportReadings.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { invalidateBlendedScore } from '../services/ledger/blendedScoreCache.js';
import { listAdminReports, adminReportLink } from '../services/adminReportsService.js';

const router = Router();
const run = fn => async (req, res) => { try { res.json({ data: await fn(req, res) }); } catch (e) { res.status(e.status || 500).json({ error: e.status && e.status < 500 ? (e.error || e.message) : 'Could not complete this request right now. Please try again.' }); } };
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const cap = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : null;
export async function coachingEntitlement(userId) {
  const url = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
  const res = await axios.get(`${url}/coaching/internal/${userId}`, { timeout: 15000, headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(url)) } });
  return res.data.data;
}
async function ownReport(userId, id) {
  const row = await prisma.healthReport.findFirst({ where: { id: Number(id) || -1, userId }, include: { extractions: true } });
  if (!row) throw Object.assign(new Error('Report not found'), { status: 404 });
  return row;
}
const canReadAgain = r => r.status === 'COMPLETED' && r.proposedReadings == null && r.readConsentAt != null;
const reportView = r => ({
  id: r.id, fileName: r.fileName, status: r.status, createdAt: r.createdAt,
  reportDate: r.reportDate, detectedReportDate: r.detectedReportDate,
  proposedProfile: r.proposedProfile || {},
  proposedMarkers: { ...(r.proposedMarkers || {}), ...Object.fromEntries((r.extractions || []).filter(x => ['hba1c', 'triglycerides'].includes(x.metric)).map(x => [x.metric, x.normalizedValue])) },
  proposedReadings: r.proposedReadings ?? null,
  confirmedReadings: r.confirmedReadings ?? null,
  canReadAgain: canReadAgain(r),
});

router.get('/guidance/me', requireAuth, run(async req => ({
  profile: await prisma.guidanceProfile.findUnique({ where: { userId: req.userId } }),
  requests: await prisma.guidanceRequest.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 30 }),
  reports: (await prisma.healthReport.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 20, include: { extractions: true } })).map(reportView),
})));
router.post('/guidance/reports', requireRole('customer'), requireFeatureFlag('reportSubscription'), uploadMedicalDocumentMiddleware, run(async req => {
  if (req.body?.readConsent !== 'true' && req.body?.readConsent !== true) bad('Confirm permission to read your report');
  if (!req.file || !['application/pdf', 'image/jpeg', 'image/png'].includes(req.file.mimetype)) bad('Choose a PDF, JPEG or PNG report');
  const bytes = req.file.buffer;
  const matches = req.file.mimetype === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : req.file.mimetype === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!matches) bad('The file content does not match its PDF or image type');
  const path = await saveDocument({ buffer: req.file.buffer, mimeType: req.file.mimetype, userId: req.userId });
  let report;
  try {
    report = await createReportService({ userId: req.userId, storagePath: path, fileName: cap(req.file.originalname, 160) || 'Blood report', mimeType: req.file.mimetype });
    await prisma.healthReport.update({ where: { id: report.id }, data: { readConsentAt: new Date() } });
  } catch (e) { await deleteObjects([path]).catch(() => {}); throw e; }
  // Await the reader: Cloud Run can suspend background work after a response.
  // A failed read still returns its stored report so the user can retry or continue.
  await processReportService(report.id).catch(() => {});
  return reportView(await ownReport(req.userId, report.id));
}));
router.get('/guidance/reports/:id', requireAuth, run(async req => reportView(await ownReport(req.userId, req.params.id))));
router.get('/guidance/reports/:id/link', requireAuth, run(async req => ({ url: await signedDocumentUrl((await ownReport(req.userId, req.params.id)).storagePath) })));
router.post('/guidance/reports/:id/retry', requireRole('customer'), requireFeatureFlag('reportSubscription'), run(async req => {
  const row = await ownReport(req.userId, req.params.id);
  const stalled = ['PENDING', 'PROCESSING'].includes(row.status) && Date.now() - new Date(row.processingStartedAt || row.createdAt).getTime() > 300000;
  if (row.status !== 'FAILED' && !stalled && !canReadAgain(row)) {
    if (row.status === 'COMPLETED') return reportView(row);
    bad('This report is still being read. Try again in a few minutes');
  }
  const claimed = await prisma.healthReport.updateMany({ where: { id: row.id, status: row.status, processingToken: row.processingToken }, data: { status: 'PENDING', processingToken: null } });
  if (claimed.count) await processReportService(row.id).catch(() => {});
  return reportView(await ownReport(req.userId, row.id));
}));
router.post('/guidance/reports/:id/confirm', requireRole('customer'), run(async req => {
  const report = await ownReport(req.userId, req.params.id);
  if (report.status !== 'COMPLETED') bad('Wait for the report to finish reading');
  if (req.body?.belongsToMe !== true) bad('Confirm that this is your report');
  const input = req.body.details || {};
  const details = { name: cap(input.name, 120), address: cap(input.address, 500), gender: input.gender || null, age: input.age == null || input.age === '' ? null : Number(input.age) };
  if (details.gender && !['male', 'female', 'other', 'prefer_not_to_say'].includes(details.gender)) bad('Check gender');
  if (details.age != null && (!Number.isInteger(details.age) || details.age < 0 || details.age > 120)) bad('Check age');
  const markers = validateMarkers(req.body.markers);
  const readings = req.body.readings === undefined ? undefined : validateReportReadings(req.body.readings);
  const confirmedReadings = readings ?? report.confirmedReadings ?? null;
  const liverFlag = req.body.liverFlag === true;
  const reportDate = parseReportDate(req.body.reportDate);
  const previous = await prisma.guidanceProfile.findUnique({ where: { userId: req.userId } });
  const canonical = obj => JSON.stringify(Object.fromEntries(Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b))));
  const existingReadings = Array.isArray(report.confirmedReadings) ? report.confirmedReadings : [];
  const readingsUnchanged = readings === undefined || (
    readings.length === existingReadings.length &&
    readings.every((reading, index) => canonical(reading) === canonical(existingReadings[index]))
  );
  if (previous?.sourceReportId === report.id && canonical(previous.confirmedDetails) === canonical(details) && canonical(previous.confirmedMarkers) === canonical(markers) && previous.liverFlag === liverFlag && (!reportDate || reportDate === report.reportDate) && readingsUnchanged) return { ...previous, confirmedReadings };
  const data = { sourceReportId: report.id, confirmedDetails: details, confirmedMarkers: markers, liverFlag, riskBucket: riskBucket(markers, liverFlag), confirmedAt: new Date(), clinicalStatus: 'PENDING', clinicalNote: null, clinicianName: null, clinicianRegistration: null, reviewedBy: null, reviewedAt: null, agreedActions: [] };
  const result = await prisma.$transaction(async tx => {
    if (reportDate || readings !== undefined) {
      await tx.healthReport.update({
        where: { id: report.id, userId: req.userId, status: 'COMPLETED' },
        data: { ...(reportDate ? { reportDate } : {}), ...(readings === undefined ? {} : { confirmedReadings: readings }) },
      });
    }
    const localDate = reportDate || report.reportDate || report.detectedReportDate || report.createdAt.toISOString().slice(0, 10);
    for (const extraction of report.extractions) {
      if (!['hba1c', 'triglycerides'].includes(extraction.metric) || markers[extraction.metric] == null) continue;
      const value = markers[extraction.metric];
      await tx.reportExtraction.update({ where: { id: extraction.id }, data: { isVerified: true, normalizedValue: value } });
      await tx.biometricEntry.upsert({ where: { userId_metric_localDate: { userId: req.userId, metric: extraction.metric, localDate } }, create: { userId: req.userId, metric: extraction.metric, value, unit: extraction.metric === 'hba1c' ? '%' : 'mg/dL', source: 'manual', localDate }, update: { value, source: 'manual' } });
    }
    return tx.guidanceProfile.upsert({ where: { userId: req.userId }, create: { userId: req.userId, ...data }, update: data });
  });
  await invalidateBlendedScore(req.userId);
  return { ...result, confirmedReadings };
}));
router.patch('/guidance/me', requireRole('customer'), run(async req => {
  const data = { concern: cap(req.body.concern, 500), existingAdvice: cap(req.body.existingAdvice, 2000) };
  return prisma.guidanceProfile.upsert({ where: { userId: req.userId }, create: { userId: req.userId, ...data }, update: data });
}));
router.post('/guidance/requests', requireRole('customer'), run(async req => {
  const { kind } = req.body;
  if (!['COACH_CALL', 'DOCTOR_CALL', 'DIETITIAN_REVIEW', 'QUESTION', 'FORM_SESSION'].includes(kind)) bad('Choose a valid request');
  const entitlement = await coachingEntitlement(req.userId);
  if (!entitlement.isGuided) throw Object.assign(new Error('An active guided plan is required'), { status: 403 });
  const included = entitlement.offer || {};
  if (kind === 'DOCTOR_CALL' && !(included.doctorClearanceForRed ?? (entitlement.plan_type === 'QUARTERLY_11999'))) bad('Doctor clearance is not included in this purchased plan');
  if (kind === 'DIETITIAN_REVIEW' && !(included.dietitianReview ?? (entitlement.plan_type === 'QUARTERLY_11999'))) bad('Dietitian review is not included in this purchased plan');
  if (kind === 'COACH_CALL' && included.weeklyCoaching === false) bad('Coaching calls are not included in this purchased plan');
  if (kind === 'FORM_SESSION') {
    if (entitlement.benefits?.trainerFloorSessions === false) bad('Trainer floor sessions are not included in this regional plan');
    const profile = await prisma.guidanceProfile.findUnique({ where: { userId: req.userId } });
    if (profile?.clinicalStatus === 'NOT_CLEARED' || (profile?.riskBucket === 'RED' && profile.clinicalStatus !== 'CLEARED')) bad('Clinical clearance is required before guided form sessions');
    if (entitlement.free_delight_sessions_remaining + entitlement.addon_trainer_sessions_remaining < 1) bad('No trainer sessions remain');
  }
  const preferredAt = req.body.preferredAt ? new Date(req.body.preferredAt) : null;
  if (preferredAt && (!Number.isFinite(+preferredAt) || preferredAt <= new Date())) bad('Choose a future appointment time');
  const message = cap(req.body.message, 2000) || '';
  if (kind === 'QUESTION' && !message) bad('Enter your question');
  const existing = await prisma.guidanceRequest.findFirst({ where: { userId: req.userId, kind, status: 'REQUESTED', message, preferredAt } });
  return existing || prisma.guidanceRequest.create({ data: { userId: req.userId, kind, message, preferredAt } });
}));
router.get('/guidance/internal/:userId', requireInternal, run(async req => prisma.guidanceProfile.findUnique({ where: { userId: Number(req.params.userId) } })));
router.get('/guidance/admin', requireRole('gobhi'), run(async () => ({ profiles: await prisma.guidanceProfile.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 }), requests: await prisma.guidanceRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }) })));
router.get('/guidance/admin/reports', requireRole('gobhi'), run(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  return listAdminReports(req.query);
}));
router.get('/guidance/admin/reports/:source/:id/link', requireRole('gobhi'), run(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  return adminReportLink(req.params.source, req.params.id);
}));
router.get('/guidance/admin/:userId/report-link', requireRole('gobhi'), run(async req => {
  const profile = await prisma.guidanceProfile.findUnique({ where: { userId: Number(req.params.userId) } });
  if (!profile?.sourceReportId || !profile.confirmedAt) throw Object.assign(new Error('No confirmed source report'), { status: 404 });
  const report = await ownReport(profile.userId, profile.sourceReportId);
  return { url: await signedDocumentUrl(report.storagePath) };
}));
router.post('/guidance/admin/:userId/review', requireRole('gobhi'), run(async req => {
  const clinicianName = cap(req.body.clinicianName, 150), clinicianRegistration = cap(req.body.clinicianRegistration, 100), clinicalNote = cap(req.body.clinicalNote, 10000);
  if (!clinicianName || !clinicianRegistration || !clinicalNote || req.body.attestReviewed !== true) bad('Record the reviewing clinician, registration, signed note and review attestation');
  const clinicalStatus = req.body.clinicalStatus;
  if (!['CLEARED', 'FOLLOW_UP_REQUIRED', 'NOT_CLEARED'].includes(clinicalStatus)) bad('Choose a review outcome');
  const actions = req.body.agreedActions || [];
  if (!Array.isArray(actions) || actions.length > 20 || actions.some(a => typeof a !== 'string' || a.length > 500)) bad('Check the agreed actions');
  const current = await prisma.guidanceProfile.findUnique({ where: { userId: Number(req.params.userId) } });
  if (!current?.confirmedAt) bad('The customer must confirm their report before clinical review');
  if (req.body.sourceReportId !== current.sourceReportId) bad('The report has changed; reload before recording a review');
  if (new Date(req.body.confirmedAt).getTime() !== current.confirmedAt.getTime()) bad('The confirmed report changed. Reload before recording the review');
  const saved = await prisma.guidanceProfile.updateMany({ where: { userId: current.userId, sourceReportId: current.sourceReportId, confirmedAt: current.confirmedAt }, data: { clinicalStatus, clinicalNote, clinicianName, clinicianRegistration, agreedActions: actions, reviewedBy: req.userId, reviewedAt: new Date() } });
  if (!saved.count) bad('The confirmed report changed. Reload before saving clinical review');
  return prisma.guidanceProfile.findUnique({ where: { userId: current.userId } });
}));
router.patch('/guidance/admin/requests/:id', requireRole('gobhi'), run(async req => {
  if (!['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED'].includes(req.body.status)) bad('Choose a request status');
  return prisma.guidanceRequest.update({ where: { id: Number(req.params.id) }, data: { status: req.body.status } });
}));
export default router;
