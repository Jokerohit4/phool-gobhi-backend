import {
  createReportService,
  processReportService,
  getPendingExtractionsService,
  verifyExtractionService,
  listReportsService,
  deleteReportService,
} from '../services/reportService.js';
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
    const userId = req.user.id;

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
    });

    // Processing is async and deliberately not awaited: OCR takes seconds to
    // minutes, and the user is told to expect a pending list rather than left
    // watching a spinner for two minutes to learn there was one error number in
    // their bloodwork.
    processReportService(report.id).catch((err) =>
      console.error(`[reports] async processing failed for report ${report.id}:`, err?.message),
    );

    // storagePath never leaves the service. Neither does the raw OCR output —
    // the client gets the id and the status, and comes back for the pending
    // extractions via GET /reports/pending once processing finishes.
    res.status(201).json({
      data: {
        id: report.id,
        fileName: report.fileName,
        status: report.status,
        createdAt: report.createdAt,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const listReports = async (req, res) => {
  try {
    const reports = await listReportsService(req.user.id);
    res.json({ data: reports });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const getPendingExtractions = async (req, res) => {
  try {
    const userId = req.user.id;
    const extractions = await getPendingExtractionsService(userId);
    res.json({ data: extractions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const verifyExtraction = async (req, res) => {
  try {
    const { extractionId, confirmedValue } = req.body;
    const userId = req.user.id;

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
    const out = await deleteReportService({ reportId: req.params.id, userId: req.user.id });
    res.json({ data: out });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};