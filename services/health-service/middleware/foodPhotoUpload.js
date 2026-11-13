import multer from 'multer';
import { MAX_PHOTO_BYTES, isAllowedMimeType } from '../services/ledger/foodPhotoStorage.js';

// Images only, one per request, buffered in memory.
//
// Same three decisions as medicalUpload.js - memory storage, a single file, and
// a MIME allowlist that is a filter rather than a guarantee - because they are
// right for the same reasons. The MIME type is a claim from the client, so the
// private bucket and the never-persisted-signed-URL rule are what actually
// enforce anything, not this filter.
//
// A separate middleware rather than a parameterised medicalUpload, so the two
// limits cannot drift into each other: 8 MB of JPEG is a generous plate photo
// and a wildly oversized lab report, and coupling the two would mean the
// stricter number quietly governing both.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PHOTO_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (isAllowedMimeType(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('That image type is not accepted'), { status: 400 }));
  },
});

function handleUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `That photo is larger than ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB`,
        code: 'FILE_TOO_LARGE',
      });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, code: 'FILE_REJECTED' });

    console.error('[foodPhoto] upload failed:', err.message);
    return res.status(500).json({ error: 'Upload failed', code: 'UPLOAD_FAILED' });
  });
}

export const uploadFoodPhotoMiddleware = handleUpload;
