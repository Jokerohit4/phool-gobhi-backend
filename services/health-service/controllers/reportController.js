import { createHash } from 'node:crypto';
import {
  createReportService,
  processReportService,
  getPendingExtractionsService,
  verifyExtractionService,
  listReportsService,
  deleteReportService,
  findExistingReport,
  getReportSummaryService,
} from '../services/reportService.js';
import { estimatePdfPages, MAX_REPORT_PAGES } from '../utils/reportFailure.js';
import { isAllowedReportMimeType, saveDocument } from '../services/ledger/medicalDocumentStorage.js';

// The Local Health Vault: upload a lab report, let OCR propose the numbers, and
// let the user confirm each one before it touches their health history.
//
// One thing changed here and it is worth stating plainly, because the shape of
// this controller was previously unrunnable. It used to read a `cloudinaryUrl`
// out of a JSON body and required the client to have uploaded the PDF to
// Cloudinary first. Nothing in any client ever did that — the Flutter app had no
// Cloudinary code at all — so this endpoint could only ever have been called by
// hand, with a URL to a PDF that did not exist. The route existed, the service
// existed, the verification screen existed, and there was no way to put a file
// in.
//
// The upload is now multipart and server-side, for the same reason every other
// medical file in this service is: object-store credentials must not live in a
// mobile client, and a signed upload preset is still a credential with a public
// name. The bytes go to the same private GCS bucket as prescriptions and lab
// reports (see medicalDocumentStorage.js), under the same `medical/{userId}/`
// prefix, which means the existing prefix sweep on account deletion reclaims
// them with no new erasure path.
//
// The cost of the change is that the file passes through this service rather
// than going straight to storage. That is the same trade the medical-document
// upload already makes and accepts deliberately: one copy, in memory, for the
// length of one request.
export const uploadReport = async (req, res) => {
  try {
    const userId = req.userId;

    if (!req.file) {
      return res.status(400).json({ error: 'No file received', code: 'NO_FILE' });
    }

    // Re-checked here as well as in the multer filter. The filter is a claim
    // from the client, and OCR only reads PDFs — an image uploaded here would be
    // labelled application/pdf to Document AI and fail with an error that looks
    // like a corrupt file rather than a wrong format.
    if (!isAllowedReportMimeType(req.file.mimetype)) {
      return res.status(400).json({
        error: 'Upload the lab report as a PDF',
        code: 'UNSUPPORTED_TYPE',
      });
    }

    // Before any storage write or paid read: a file that is plainly too long is
    // refused with advice, and the same bytes uploaded again are answered from
    // the report this user already has.
    if ((estimatePdfPages(req.file.buffer) || 0) > MAX_REPORT_PAGES) {
      return res.status(400).json({
        error: `This report has more than ${MAX_REPORT_PAGES} pages. Upload only the pages with your results.`,
        code: 'TOO_LONG',
      });
    }
    const fileSha256 = createHash('sha256').update(req.file.buffer).digest('hex');
    const existing = await findExistingReport(userId, fileSha256);
    if (existing) {
      const summary = await getReportSummaryService({ reportId: existing.id, userId });
      return res.status(200).json({ data: summary });
    }

    const storagePath = await saveDocument({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      userId,
    });

    // fileName is the user's own filename, trimmed and capped rather than
    // trusted: it goes in the list they see it in, and it must not be a lever
    // for storing something unbounded.
    const fileName =
      String(req.file.originalname || 'Lab report')
        .trim()
        .slice(0, 160) || 'Lab report';

    // reportDate rides along as a text field on the multipart body rather than in
    // the filename or a header. The user can read the date off the document they
    // are uploading; nothing else in the request can be trusted to know it. Omit
    // it and the row is stored with a NULL date and the verify step falls back to
    // the upload timestamp - an approximation that is visibly an approximation.
    const report = await createReportService({
      userId,
      storagePath,
      fileName,
      reportDate: req.body?.reportDate,
      fileSha256,
    });

    // Awaited, like the guidance upload. This used to start processing and
    // return, but Cloud Run can freeze an instance as soon as the response is
    // sent, so the read could stop half way and leave the report PENDING for
    // good. Waiting costs the user the length of one read; the app shows
    // progress for it. A failed read is not an upload error: the file is saved,
    // the report row says FAILED with a reason, and the person can try again.
    await processReportService(report.id).catch((err) =>
      console.error(`[reports] processing failed for report ${report.id}:`, err?.message),
    );

    // storagePath never leaves the service. Neither does the raw OCR output.
    // The row comes back in the list shape, with the final status and the number
    // of values waiting, so the screen needs no second request to draw it.
    //
    // reportDate is echoed because the user's date picker and the stored value
    // can disagree, and a silent disagreement is only discovered weeks later
    // when a trend looks wrong with no way to see why.
    res.status(201).json({ data: await getReportSummaryService({ reportId: report.id, userId }) });
  } catch (err) {
    // code is passed through so the app can say "that date isn't real" rather
    // than "upload failed" - the two are very different things to a user who
    // just watched their file upload successfully.
    res.status(err.status || 500).json({
      error: err.error || 'Internal server error',
      ...(err.code ? { code: err.code } : {}),
    });
  }
};

export const listReports = async (req, res) => {
  try {
    const reports = await listReportsService(req.userId);
    res.json({ data: reports });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const getPendingExtractions = async (req, res) => {
  try {
    const userId = req.userId;
    const extractions = await getPendingExtractionsService(userId);
    res.json({ data: extractions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const verifyExtraction = async (req, res) => {
  try {
    const { extractionId, confirmedValue } = req.body;
    const userId = req.userId;

    if (!extractionId || confirmedValue === undefined) {
      return res.status(400).json({ error: 'extractionId and confirmedValue are required' });
    }

    const result = await verifyExtractionService({
      extractionId: Number(extractionId),
      userId,
      confirmedValue: Number(confirmedValue),
    });

    res.json({ data: { message: result.message } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const deleteReport = async (req, res) => {
  try {
    const out = await deleteReportService({ reportId: req.params.id, userId: req.userId });
    res.json({ data: out });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};
