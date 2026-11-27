import { Router } from 'express';
import axios from 'axios';
import prisma from '../db/prisma.js';
import { requireAuth, requireRole, requireInternal } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { uploadMedicalDocumentMiddleware } from '../middleware/medicalUpload.js';
import { saveDocument, signedDocumentUrl, deleteObjects } from '../services/ledger/medicalDocumentStorage.js';
import { createHash } from 'node:crypto';
import { createReportService, processReportService, parseReportDate, findExistingReport } from '../services/reportService.js';
import { PATIENT_DETAILS_VERSION, publicProposedProfile, validateMarkers, riskBucket } from '../utils/guidanceExtraction.js';
import { validateReportReadings } from '../utils/reportReadings.js';
import { valuesFromReadings, BIOMETRIC_KEYS, BIOMETRIC_BOUNDS, MARKER_KEYS } from '../utils/readingMetrics.js';
import { isStalledReport, estimatePdfPages, matchesDeclaredType, MAX_REPORT_PAGES } from '../utils/reportFailure.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { invalidateBlendedScore } from '../services/ledger/blendedScoreCache.js';
import { listAdminReports, adminReportLink } from '../services/adminReportsService.js';
import { notifyUser } from '../utils/notifyUser.js';
import { riskNoticeFor } from '../utils/reportRiskNotice.js';
import { conditionAnswer, conditionView, checkoutCondition, lockGuidanceCondition, recordReportCondition, saveGuidanceCondition } from '../services/guidanceConditionService.js';

const router = Router();
const run = fn => async (req, res) => { try { res.json({ data: await fn(req, res) }); } catch (e) { res.status(e.status || 500).json({ error: e.status && e.status < 500 ? (e.error || e.message) : 'Could not complete this request right now. Please try again.' }); } };
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const cap = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : null;
function profileUserId(value) {
  const userId = Number(value);
  if (!Number.isInteger(userId) || userId < 1 || userId > 2147483647) bad('Invalid user ID');
  return userId;
}
export async function coachingEntitlement(userId) {
  const url = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
  const res = await axios.get(`${url}/coaching/internal/${userId}`, { timeout: 15000, headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...(await googleIdTokenHeader(url)) } });
  return res.data.data;
}
async function ownReport(userId, id, db = prisma) {
  const row = await db.healthReport.findFirst({ where: { id: Number(id) || -1, userId }, include: { extractions: true } });
  if (!row) throw Object.assign(new Error('Report not found'), { status: 404 });
  return row;
}
const canReadAgain = r => r.status === 'COMPLETED' && r.readConsentAt != null &&
  (r.proposedReadings == null ||
    (!r.proposedProfile?.name && r.proposedProfile?._patientDetailsVersion !== PATIENT_DETAILS_VERSION));
// Prefer the readings shown to the person, with older extraction formats as fallbacks.
const proposedMarkersFor = r => ({
  ...(r.proposedMarkers || {}),
  ...Object.fromEntries((r.extractions || []).filter(x => ['hba1c', 'triglycerides'].includes(x.metric)).map(x => [x.metric, x.normalizedValue])),
  ...valuesFromReadings(r.proposedReadings, MARKER_KEYS),
});
const reportView = r => ({
  id: r.id, fileName: r.fileName, status: r.status, createdAt: r.createdAt,
  reportDate: r.reportDate, detectedReportDate: r.detectedReportDate,
  proposedProfile: publicProposedProfile(r.proposedProfile),
  proposedMarkers: proposedMarkersFor(r),
  proposedReadings: r.proposedReadings ?? null,
  confirmedReadings: r.confirmedReadings ?? null,
  canReadAgain: canReadAgain(r),
  failureCode: r.status === 'FAILED' ? r.failureCode ?? 'READ_FAILED' : null,
  stalled: isStalledReport(r),
});
// The list needs a row, not the report: readings can run to hundreds per file and
// opening one fetches it by id.
const SUMMARY_FIELDS = { id: true, fileName: true, status: true, createdAt: true, updatedAt: true, processingStartedAt: true, reportDate: true, detectedReportDate: true, failureCode: true };
const reportSummary = r => ({
  id: r.id, fileName: r.fileName, status: r.status, createdAt: r.createdAt,
  reportDate: r.reportDate, detectedReportDate: r.detectedReportDate,
  failureCode: r.status === 'FAILED' ? r.failureCode ?? 'READ_FAILED' : null,
  stalled: isStalledReport(r),
});

router.get('/guidance/me', requireAuth, run(async req => ({
  profile: await prisma.guidanceProfile.findUnique({ where: { userId: req.userId } }),
  requests: await prisma.guidanceRequest.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 30 }),
  reports: (await prisma.healthReport.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 10, select: SUMMARY_FIELDS })).map(reportSummary),
})));
router.get('/guidance/profile/condition', requireRole('customer'), run(async req =>
  conditionView(await prisma.guidanceProfile.findUnique({ where: { userId: req.userId } }))));
router.put('/guidance/profile/condition', requireRole('customer'), run(req =>
  saveGuidanceCondition(req.userId, { answer: conditionAnswer(req.body ?? {}) })));
router.post('/guidance/reports', requireRole('customer'), requireFeatureFlag('reportSubscription'), uploadMedicalDocumentMiddleware, run(async req => {
  if (req.body?.readConsent !== 'true' && req.body?.readConsent !== true) bad('Confirm permission to read your report');
  if (!req.file || !['application/pdf', 'image/jpeg', 'image/png'].includes(req.file.mimetype)) bad('Choose a PDF, JPEG or PNG report');
  const bytes = req.file.buffer;
  if (!matchesDeclaredType(req.file.mimetype, bytes)) bad('The file content does not match its PDF or image type');
  // Before any storage write or paid read: a file that is plainly too long is
  // refused with advice, and the same file uploaded again is answered from the
  // report the person already has.
  if (req.file.mimetype === 'application/pdf' && (estimatePdfPages(bytes) || 0) > MAX_REPORT_PAGES) bad(`This report has more than ${MAX_REPORT_PAGES} pages. Upload only the pages with your results.`);
  const fileSha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await findExistingReport(req.userId, fileSha256);
  if (existing) return reportView(await ownReport(req.userId, existing.id));
  const path = await saveDocument({ buffer: req.file.buffer, mimeType: req.file.mimetype, userId: req.userId });
  let report;
  try {
    report = await createReportService({ userId: req.userId, storagePath: path, fileName: cap(req.file.originalname, 160) || 'Blood report', mimeType: req.file.mimetype, fileSha256, readConsentAt: new Date() });
  } catch (e) { await deleteObjects([path]).catch(() => {}); throw e; }
  // Await the reader: Cloud Run can suspend background work after a response.
  // A failed read still returns its stored report so the user can retry or continue.
  await processReportService(report.id).catch(() => {});
  return reportView(await ownReport(req.userId, report.id));
}));
// Recover an upload whose connection closed before it could return the report
// ID. The fingerprint stays in the request body and is scoped to this account.
router.post('/guidance/reports/resume', requireRole('customer'), requireFeatureFlag('reportSubscription'), run(async req => {
  const fileSha256 = req.body?.fileSha256;
  if (typeof fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fileSha256)) bad('Invalid report fingerprint');
  const report = await prisma.healthReport.findFirst({
    where: { userId: req.userId, fileSha256 },
    orderBy: { createdAt: 'desc' },
    include: { extractions: true },
  });
  return report ? reportView(report) : null;
}));
router.get('/guidance/reports/:id', requireAuth, run(async req => reportView(await ownReport(req.userId, req.params.id))));
router.get('/guidance/reports/:id/link', requireAuth, run(async req => ({ url: await signedDocumentUrl((await ownReport(req.userId, req.params.id)).storagePath) })));
router.post('/guidance/reports/:id/retry', requireRole('customer'), requireFeatureFlag('reportSubscription'), run(async req => {
  const row = await ownReport(req.userId, req.params.id);
  const stalled = isStalledReport(row);
  if (row.status !== 'FAILED' && !stalled && !canReadAgain(row)) {
    if (row.status === 'COMPLETED') return reportView(row);
    bad('This report is still being read. Try again in a few minutes');
  }
  const claimed = await prisma.healthReport.updateMany({ where: { id: row.id, status: row.status, processingToken: row.processingToken }, data: { status: 'PENDING', processingToken: null } });
  if (claimed.count) await processReportService(row.id).catch(() => {});
  return reportView(await ownReport(req.userId, row.id));
}));
router.post('/guidance/reports/:id/confirm', requireRole('customer'), run(async req => {
  const { previous, result, replay, confirmedReadings } = await prisma.$transaction(async tx => {
    await lockGuidanceCondition(tx, req.userId);
    const report = await ownReport(req.userId, req.params.id, tx);
    if (report.status !== 'COMPLETED') bad('Wait for the report to finish reading');
    if (req.body?.belongsToMe !== true) bad('Confirm that this is your report');
    const input = req.body.details || {};
    const details = { name: cap(input.name, 120), address: cap(input.address, 500), gender: input.gender || null, age: input.age == null || input.age === '' ? null : Number(input.age) };
    if (details.gender && !['male', 'female', 'other', 'prefer_not_to_say'].includes(details.gender)) bad('Check gender');
    if (details.age != null && (!Number.isInteger(details.age) || details.age < 0 || details.age > 120)) bad('Check age');
    const typedMarkers = validateMarkers(req.body.markers);
    const readings = req.body.readings === undefined ? undefined : validateReportReadings(req.body.readings);
    const confirmedReadings = readings ?? report.confirmedReadings ?? null;
    // Prefer a value the customer typed. Fill blank markers from the reviewed readings.
    const reviewed = confirmedReadings ?? report.proposedReadings;
    const markers = { ...valuesFromReadings(reviewed, MARKER_KEYS), ...typedMarkers };
    if (!Object.keys(markers).length && !reviewed?.some(reading => String(reading.value ?? '').trim())) {
      bad('Add a report value before confirming, or continue without the report');
    }
    const biometrics = { ...valuesFromReadings(reviewed, BIOMETRIC_KEYS), ...Object.fromEntries(['hba1c', 'triglycerides'].filter(key => markers[key] != null).map(key => [key, markers[key]])) };
    const liverFlag = req.body.liverFlag === true;
    const reportDate = parseReportDate(req.body.reportDate);
    const canonical = obj => JSON.stringify(Object.fromEntries(Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b))));
    const existingReadings = Array.isArray(report.confirmedReadings) ? report.confirmedReadings : [];
    const readingsUnchanged = readings === undefined || (
      readings.length === existingReadings.length &&
      readings.every((reading, index) => canonical(reading) === canonical(existingReadings[index]))
    );
    const previous = await recordReportCondition(tx, req.userId);
    if (previous.sourceReportId === report.id && canonical(previous.confirmedDetails) === canonical(details) && canonical(previous.confirmedMarkers) === canonical(markers) && previous.liverFlag === liverFlag && (!reportDate || reportDate === report.reportDate) && readingsUnchanged) {
      return { result: previous, confirmedReadings, replay: true };
    }
    const data = { sourceReportId: report.id, confirmedDetails: details, confirmedMarkers: markers, liverFlag, riskBucket: riskBucket(markers, liverFlag), confirmedAt: new Date(), clinicalStatus: 'PENDING', clinicalNote: null, clinicianName: null, clinicianRegistration: null, reviewedBy: null, reviewedAt: null, agreedActions: [] };
    if (reportDate || readings !== undefined) {
      await tx.healthReport.update({
        where: { id: report.id, userId: req.userId, status: 'COMPLETED' },
        data: { ...(reportDate ? { reportDate } : {}), ...(readings === undefined ? {} : { confirmedReadings: readings }) },
      });
    }
    const localDate = reportDate || report.reportDate || report.detectedReportDate || report.createdAt.toISOString().slice(0, 10);
    // Every value the reader proposed is settled here, not just the two that feed
    // guidance. One the person kept is saved; one they removed or emptied is
    // dropped. Left alone, the rest would sit unconfirmed and turn up again as
    // "waiting for you" in the vault for a report already reviewed.
    const settled = new Set();
    for (const extraction of report.extractions) {
      if (!BIOMETRIC_KEYS.includes(extraction.metric)) continue;
      const value = biometrics[extraction.metric];
      if (value == null) {
        if (!extraction.isVerified) await tx.reportExtraction.delete({ where: { id: extraction.id } });
        continue;
      }
      await tx.reportExtraction.update({ where: { id: extraction.id }, data: { isVerified: true, normalizedValue: value } });
      await tx.biometricEntry.upsert({ where: { userId_metric_localDate: { userId: req.userId, metric: extraction.metric, localDate } }, create: { userId: req.userId, metric: extraction.metric, value, unit: extraction.metric === 'hba1c' ? '%' : 'mg/dL', source: 'manual', localDate }, update: { value, source: 'manual' } });
      settled.add(extraction.metric);
    }
    // A value the person typed, or that came from a reading, counts even when the
    // reader never produced an extraction row for it (a layout it missed). Left
    // out, HbA1c would steer the risk bucket but never reach their history or
    // score. Same sanity bounds as the biometric store, so a typo stays out.
    for (const [metric, value] of Object.entries(biometrics)) {
      if (settled.has(metric)) continue;
      const bounds = BIOMETRIC_BOUNDS[metric];
      if (!bounds || value < bounds[0] || value > bounds[1]) continue;
      await tx.biometricEntry.upsert({ where: { userId_metric_localDate: { userId: req.userId, metric, localDate } }, create: { userId: req.userId, metric, value, unit: metric === 'hba1c' ? '%' : 'mg/dL', source: 'manual', localDate }, update: { value, source: 'manual' } });
    }
    const result = await tx.guidanceProfile.update({ where: { userId: req.userId }, data });
    return { previous, result, confirmedReadings };
  });
  if (replay) return { ...result, confirmedReadings };
  await invalidateBlendedScore(req.userId);
  // Best effort and never awaited: the person already has their answer, so a
  // slow or failed push must not hold up or fail the confirm.
  // Off unless REPORT_RISK_PUSH_ENABLED=true (dev only until the cutoffs are
  // clinically signed off).
  const notice = process.env.REPORT_RISK_PUSH_ENABLED === 'true' ? riskNoticeFor(previous?.riskBucket, result.riskBucket) : null;
  if (notice) notifyUser(req.userId, notice).catch(() => {});
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
router.get('/guidance/internal/:userId', requireInternal, run(async req => {
  const userId = profileUserId(req.params.userId);
  const [profile, report] = await Promise.all([
    prisma.guidanceProfile.findUnique({ where: { userId } }),
    prisma.healthReport.findFirst({ where: { userId }, select: { id: true } }),
  ]);
  return { ...profile, ...conditionView(profile), hasUploadedReport: !!report };
}));
router.put('/guidance/internal/:userId/condition', requireInternal, run(req =>
  saveGuidanceCondition(profileUserId(req.params.userId), checkoutCondition(req.body ?? {}))));
router.put('/guidance/admin/:userId/condition', requireRole('gobhi'), run(req =>
  saveGuidanceCondition(profileUserId(req.params.userId), { answer: conditionAnswer(req.body ?? {}), staff: true })));
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
