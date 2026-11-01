import multer from 'multer';
import { MAX_PHOTO_BYTES, isAllowedMimeType } from '../services/ledger/foodPhotoStorage.js';

// Post-workout photo: same size cap and MIME allowlist as the food photo
// middleware (shared constants), single field `photo`, buffered in memory.
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

    console.error('[workoutPhoto] upload failed:', err.message);
    return res.status(500).json({ error: 'Upload failed', code: 'UPLOAD_FAILED' });
  });
}

export const uploadWorkoutPhotoMiddleware = handleUpload;
