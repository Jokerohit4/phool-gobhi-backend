import multer from 'multer';
import {
  MAX_UPLOAD_BYTES,
  isAllowedMimeType,
  isAllowedReportMimeType,
} from '../services/ledger/medicalDocumentStorage.js';

// Files are buffered in memory, never written to the service's filesystem.
//
// A temp file would be a second copy of somebody's prescription on a disk the
// app does not control, cleaned up on a best-effort schedule. Keeping it in
// memory means there is exactly one copy, it exists for the length of one
// request, and it is uploaded to a private bucket or dropped.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    // One file per request. The route takes a single document, and a
    // multi-file endpoint here would be a bulk-import feature nobody asked for.
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    // The declared MIME type is a claim from the client, so it is a filter and
    // not a guarantee - which is why the bucket must stay private and why
    // nothing ever renders a fetched document inline.
    if (isAllowedMimeType(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('That file type is not accepted'), { status: 400 }));
  },
});

/**
 * Wrap multer so its errors come out as the JSON this API returns everywhere
 * else, rather than Express's default HTML error page.
 */
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `That file is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
        code: 'FILE_TOO_LARGE',
      });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, code: 'FILE_REJECTED' });

    console.error('[ledger] upload failed:', err.message);
    return res.status(500).json({ error: 'Upload failed', code: 'UPLOAD_FAILED' });
  });
}

export const uploadMedicalDocumentMiddleware = handleUpload;

// --- Lab reports (health vault) --------------------------------------------
//
// Same shape as the medical-document upload and for the same reasons: memory
// storage, one file, the shared size cap, and a MIME filter that is a filter and
// not a guarantee.
//
// The one difference is the accepted type. A lab report is fed to Document AI,
// which reads PDFs, so this rejects images at the door. They are accepted for
// medical documents, where nothing reads the content and a photo of a
// prescription is a normal thing to attach — but here a rejected JPEG is a
// clear message instead of a parsing failure the user will read as "your lab
// report is broken".
const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (isAllowedReportMimeType(file.mimetype)) return cb(null, true);
    cb(
      Object.assign(new Error('Upload the lab report as a PDF'), {
        status: 400,
        code: 'UNSUPPORTED_TYPE',
      }),
    );
  },
});

function handleReportUpload(req, res, next) {
  reportUpload.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `That file is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
        code: 'FILE_TOO_LARGE',
      });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code || 'FILE_REJECTED' });
    }

    console.error('[reports] upload failed:', err.message);
    return res.status(500).json({ error: 'Upload failed', code: 'UPLOAD_FAILED' });
  });
}

export const uploadHealthReportMiddleware = handleReportUpload;
