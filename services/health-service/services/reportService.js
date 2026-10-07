import { PrismaClient } from '@prisma/client';
import { track } from '../utils/analytics.js';
import { extractBiomarkersFromPDF } from '../utils/ocrService.js';
import { signedDocumentUrl } from './ledger/medicalDocumentStorage.js';
import { invalidateBlendedScore } from './ledger/blendedScoreCache.js';

const prisma = new PrismaClient();

/**
 * Service to handle medical report uploads and biomarker extraction.
 * Part of the "Local Health Vault" implementation.
 */

const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The date printed on the report, or null when the user did not say.
 *
 * Why this is asked for rather than inferred: every value in a lab report is a
 * reading of a past moment, and BiometricEntry is unique on
 * (userId, metric, localDate). Dating those entries by upload time puts a March
 * panel into an August trend - drawing a cliff that never happened - and
 * confirming two reports on the same day makes the second overwrite the first.
 * Two real measurements, one row, no error.
 *
 * Why it is asked rather than read by OCR: Document AI returns the biomarker
 * values this service parses without a collection date, and a lab report's date
 * lives in a dozen layouts (header, footer, "Collected:", "Drawn:") that OCR
 * would have to guess between. The user is holding the document and can read
 * it exactly. Guessing and asking differ by being wrong in a way nobody notices.
 *
 * Null is a real answer, not a failure. It is stored as NULL and the verify step
 * falls back to the upload timestamp - an approximation that says so, rather
 * than a guess recorded as fact.
 */
export function parseReportDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;

  const date = String(value).trim();
  if (!REPORT_DATE_RE.test(date)) {
    throw { status: 400, error: 'Report date must be YYYY-MM-DD', code: 'DATE_INVALID' };
  }

  // Shape is not validity. '2026-02-31' matches the regex and is not a day, and
  // new Date() parses it to 2 March without complaint - which would file a
  // patient's blood panel under a date the lab never reported.
  const [y, m, d] = date.split('-').map(Number);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (
    asDate.getUTCFullYear() !== y ||
    asDate.getUTCMonth() !== m - 1 ||
    asDate.getUTCDate() !== d
  ) {
    throw { status: 400, error: 'Report date is not a real date', code: 'DATE_INVALID' };
  }

  if (y < 1900) {
    throw { status: 400, error: 'Report date is implausibly old', code: 'DATE_INVALID' };
  }

  // A report drawn in the future is a typo or a forgery, and either way it
  // belongs nowhere in a health history. Two days of slack absorbs the user's
  // timezone: UTC+14 is already tomorrow in UTC, and rejecting that would fail
  // an honest user for doing nothing wrong.
  const twoDaysFromNow = new Date();
  twoDaysFromNow.setUTCDate(twoDaysFromNow.getUTCDate() + 2);
  if (asDate.getTime() > Date.UTC(
    twoDaysFromNow.getUTCFullYear(),
    twoDaysFromNow.getUTCMonth(),
    twoDaysFromNow.getUTCDate(),
  )) {
    throw { status: 400, error: 'Report date cannot be in the future', code: 'DATE_INVALID' };
  }

  return date;
}

export async function createReportService({ userId, storagePath, fileName, sizeBytes = null, mimeType = null, reportDate = null }) {
  // Before the try, not inside it. A bad date from the upload form is a client
  // error and must not be laundered into the 500 below, which would tell a user
  // their upload failed rather than that they mistyped the date.
  const parsedReportDate = parseReportDate(reportDate);

  try {
    const report = await prisma.healthReport.create({
      data: {
        userId,
        storagePath,
        fileName,
        status: 'PENDING',
        reportDate: parsedReportDate,
      },
    });

    // No path, no filename and no size in the event. The fact that a report was
    // uploaded is the only thing worth a funnel; a lab report's filename and
    // byte count are nobody's business.
    track('health_report_uploaded', userId, { status: 'PENDING' });
    return report;
  } catch (err) {
    console.error('createReportService error:', err);
    throw { status: 500, error: 'Failed to record report upload' };
  }
}

/**
 * Orchestrates the OCR extraction process.
 * Now integrated with Google Document AI via ocrService.js.
 */
export async function processReportService(reportId) {
  try {
    const report = await prisma.healthReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw { status: 404, error: 'Report not found' };

    // Legacy shape: a row whose storagePath is an http(s) URL rather than a
    // bucket object path.
    //
    // The column was renamed from cloudinaryUrl and RENAME preserves data, so if
    // any row was ever written through the old contract it still holds a full
    // URL here. Handing that to signedDocumentUrl asks GCS for an object named
    // "https://res.cloudinary.com/...", which cannot succeed on any retry and
    // reports as a generic 502 that says nothing about the real cause.
    //
    // Checked before anything else, including the status flip below, so this
    // makes no doomed network call to learn something the value itself already
    // says. Marked FAILED with a reason rather than left retrying: a row that can
    // never resolve is a user's report stuck forever with no indication of why.
    if (/^https?:\/\//i.test(report.storagePath || '')) {
      await prisma.healthReport.update({
        where: { id: reportId },
        data: { status: 'FAILED' },
      });
      return {
        status: 'FAILED',
        message: 'Stored report predates the current storage layout',
      };
    }

    // Update status to processing
    await prisma.healthReport.update({
      where: { id: reportId },
      data: { status: 'PROCESSING' },
    });

    // The OCR service fetches the document over HTTP, so it needs a URL rather
    // than a bucket path. Minted here, for this one call, and discarded — the
    // bucket has no public access and the path is the only thing stored.
    //
    // This is the reason the report PDF can live in the same private bucket as
    // every other medical record instead of needing a publicly-readable host:
    // the URL exists for the length of one HTTP fetch inside this function.
    //
    // A failure to mint is a processing failure, not a silent skip. The report
    // stays PROCESSING and is retried/orphaned rather than being marked FAILED
    // with no reason, because "could not read the bucket" and "the PDF had no
    // biomarkers in it" are different problems and only one of them is the
    // user's document being wrong.
    const signedUrl = await signedDocumentUrl(report.storagePath);
    if (!signedUrl) {
      throw { status: 502, error: 'Could not read the stored report' };
    }

    // Use the real OCR service to extract markers from the PDF
    const { extractions, detectedDate } = await extractBiomarkersFromPDF(signedUrl);

    if (!extractions || extractions.length === 0) {
      await prisma.healthReport.update({
        where: { id: reportId },
        data: { status: 'FAILED' },
      });
      return { status: 'FAILED', message: 'No biomarkers extracted' };
    }

    // The printed collection date, read off the same page as the values.
    //
    // Only written when the user gave no date of their own. reportDate is what
    // the app calls "you said this"; detectedReportDate is what it calls "read
    // off your report". Overwriting the former with the latter would be an
    // unannounced downgrade of a user's own statement to a machine's guess, and
    // the two would be indistinguishable afterwards - which matters because a
    // wrong date here silently misdates their health history.
    //
    // Best-effort by design: a missing date costs a question at upload time, a
    // date write that fails would cost the whole report. Caught and logged so a
    // detection problem is visible without turning it into a processing failure.
    if (detectedDate?.date && !report.reportDate) {
      await prisma.healthReport.update({
        where: { id: reportId },
        data: { detectedReportDate: detectedDate.date },
      }).catch((err) => {
        console.error('[report] detected date write failed:', err?.message);
      });
    }

    // Save extractions to the database
    await prisma.reportExtraction.createMany({
      data: extractions.map(ex => ({
        reportId,
        metric: ex.metric,
        rawValue: ex.rawValue,
        normalizedValue: ex.normalizedValue,
        unit: ex.unit,
        confidence: ex.confidence,
        isVerified: false,
      })),
    });

    await prisma.healthReport.update({
      where: { id: reportId },
      data: { 
        status: 'COMPLETED',
        processedAt: new Date(),
      },
    });

    return { status: 'COMPLETED', extractionsCount: extractions.length };
  } catch (err) {
    console.error('processReportService error:', err);
    await prisma.healthReport.update({
      where: { id: reportId },
      data: { status: 'FAILED' },
    }).catch(() => {});
    throw { status: 500, error: 'Report processing failed' };
  }
}

export async function getPendingExtractionsService(userId) {
  try {
    const reports = await prisma.healthReport.findMany({
      where: { 
        userId,
        status: 'COMPLETED',
      },
      include: {
        extractions: {
          where: { isVerified: false },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Flatten the reports into a list of pending extractions for the UI
    return reports.flatMap(r => 
      r.extractions.map(ex => ({
        ...ex,
        reportId: r.id,
        reportFileName: r.fileName,
      }))
    );
  } catch (err) {
    console.error('getPendingExtractionsService error:', err);
    throw { status: 500, error: 'Failed to fetch pending extractions' };
  }
}

/**
 * The date a report's values belong to, as 'YYYY-MM-DD'.
 *
 * Three sources, in order of how much they can be trusted:
 *   1. reportDate          - the user said this.
 *   2. detectedReportDate  - read off the report's own text by OCR.
 *   3. createdAt           - the upload day, the last resort.
 *
 * (2) sits above (3) and below (1) deliberately. Above (3) because a date
 * printed on the document is a real reading and the upload day is a guess that
 * happens to be true only when somebody uploads a report on the day it was
 * taken. Below (1) because the user can read their own paperwork and the parser
 * cannot see the whole page.
 *
 * All three are strings in the app's local-calendar convention, and none is
 * derived from `new Date()` at read time - which is the bug this replaces, where
 * confirming a report dated in March wrote an entry dated today.
 *
 * UTC on purpose, matching `toISOString().slice(0, 10)` everywhere else in
 * this service. A report's own date is a calendar day that was already decided
 * somewhere; reinterpreting it in the server's zone would move it.
 */
export function reportDate(report) {
  const recorded = report?.reportDate;
  if (isIsoDay(recorded)) {
    return recorded;
  }

  // Shape-checked, not trusted, even though only ocrService.js writes it: a
  // regex on the stored value costs nothing and a malformed day reaching the
  // upsert key would write a health entry under a date nothing else can parse.
  const detected = report?.detectedReportDate;
  if (isIsoDay(detected)) {
    return detected;
  }

  const created = report?.createdAt;
  if (created instanceof Date && !Number.isNaN(created.getTime())) {
    return created.toISOString().slice(0, 10);
  }

  // Unreachable while HealthReport.createdAt is NOT NULL, which the schema
  // guarantees. Falling back to today here rather than throwing, because a
  // misdated biomarker is a smaller harm than a 500 on the confirm button -
  // and the date is visible and correctable either way.
  return new Date().toISOString().slice(0, 10);
}

function isIsoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function verifyExtractionService({ extractionId, userId, confirmedValue }) {
  try {
    const extraction = await prisma.reportExtraction.findUnique({
      where: { id: extractionId },
    });

    if (!extraction) throw { status: 404, error: 'Extraction record not found' };
    
    // Security check: ensure the extraction belongs to a report owned by the user
    const report = await prisma.healthReport.findUnique({
      where: { id: extraction.reportId },
    });
    if (!report || report.userId !== userId) {
      throw { status: 403, error: 'Forbidden' };
    }

    // 1. Update the extraction as verified
    await prisma.reportExtraction.update({
      where: { id: extractionId },
      data: { 
        isVerified: true,
        normalizedValue: confirmedValue // User might have corrected the AI's value
      },
    });

    // 2. Sync to the main BiometricEntry table (The la la land of biological data)
    // This ensures the value is now part of the user's health history
    //
    // The date is the REPORT's date, not today's. A lab report is a reading of a
    // past moment - somebody uploads a blood panel from three months ago, and
    // every value in it was measured then. Dating the entry today puts a
    // March measurement in an August trend, which makes a real change look like
    // a sudden one and a steady one look like a cliff.
    //
    // This matters more than it sounds because of the upsert key. userId +
    // metric + localDate is unique, so verifying two reports on the same day
    // with today's date would overwrite the first one: upload an old panel and
    // today's manual entry, confirm both, and the second silently replaces the
    // first. Keyed on the report's own date, they are two different days and
    // both survive - which is the entire point of keeping a history.
    //
    // `report.createdAt` is the best date available: it is when the report was
    // uploaded, which is not when the blood was drawn. It is right whenever the
    // report is entered soon after the test, and closer to right than "now"
    // when it is not. The honest fix is a date printed on the report, which
    // means OCR or asking the user - so this is the fallback, not the answer,
    // and `reportDate` below is where the real one will arrive.
    const localDate = reportDate(report);

    await prisma.biometricEntry.upsert({
      where: {
        userId_metric_localDate: {
          userId,
          metric: extraction.metric,
          localDate,
        },
      },
      update: {
        value: confirmedValue,
        source: 'manual', // Marked as manual because the user verified/corrected it
      },
      create: {
        userId,
        metric: extraction.metric,
        value: confirmedValue,
        unit: extraction.unit || 'unknown',
        source: 'manual',
        localDate,
      },
    });

    await invalidateBlendedScore(userId);

    return { message: 'Biomarker verified and saved to health history' };
  } catch (err) {
    console.error('verifyExtractionService error:', err);
    throw err;
  }
}

/**
 * The user's own reports, newest first.
 *
 * storagePath is dropped on the way out for the same reason it is dropped from
 * the medical-document list: a path is a capability, and there is no reason for
 * it to leave the service when a read link can be minted on demand instead.
 *
 * fileName IS returned, unlike the upload analytics event. The user named this
 * file when they picked it and needs to recognise it in a list; a filename the
 * app cannot show back is a row they cannot tell apart from another.
 */
export async function listReportsService(userId) {
  const reports = await prisma.healthReport.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      // Just the flag, not the rows: the list needs to say "2 waiting for you"
      // and must not carry every extracted value to the device to count them.
      extractions: { select: { isVerified: true } },
    },
  });

  return reports.map(({ storagePath, extractions, ...safe }) => ({
    ...safe,
    extractionCount: extractions.length,
    pendingCount: extractions.filter((e) => !e.isVerified).length,
  }));
}

/**
 * Deletes one report, its extractions and its stored PDF.
 *
 * The per-report delete exists because the account-level erasure is not a
 * substitute for it. A user who uploads three lab reports and wants the one
 * from a hospital they no longer attend to be gone should not have to delete
 * their account to achieve that, and "erase everything" is not an answer to
 * "remove this one".
 *
 * Order matters: the row first, so the object is unreachable from the app the
 * instant this returns, then the blob best-effort. The reverse order would leave
 * a window where a storage failure had already orphaned a PDF that the database
 * still listed.
 */
export async function deleteReportService({ reportId, userId }) {
  const report = await prisma.healthReport.findFirst({
    where: { id: Number(reportId), userId },
  });
  if (!report) throw { status: 404, error: 'No such report' };

  // ReportExtraction is onDelete: Cascade from the schema, so the extractions
  // go with the row and there is nothing to enumerate here.
  await prisma.healthReport.delete({ where: { id: report.id } });

  const { deleteObjects } = await import('./ledger/medicalDocumentStorage.js');
  const { failed } = await deleteObjects([report.storagePath]).catch((err) => {
    console.error('[report] object delete failed:', err?.message);
    // Best-effort, same trade-off as medicalDocumentStorage.deleteObjects: the
    // row is gone so the object cannot be reached from the app, and the
    // `medical/{userId}/` prefix sweep on account deletion is the backstop.
    return { deleted: 0, failed: [report.storagePath] };
  });

  return { deleted: true, blobDeleted: failed.length === 0 };
}
