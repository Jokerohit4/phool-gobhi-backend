import { Storage } from '@google-cloud/storage';
import multer from 'multer';
import { randomUUID } from 'crypto';

// GCS instead of Cloudinary — Cloudinary blocks unsigned AND signed/
// authenticated delivery of PDF files by default (an account-wide anti-XSS
// policy with no per-request bypass), confirmed by testing a .txt upload
// through the identical authenticated+signed path (200) against a .pdf one
// (401) under otherwise identical config. GCS has no such restriction.
const BUCKET_NAME = process.env.RESUME_BUCKET_NAME || 'phool-gobhi-resumes';
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export const uploadResume = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Unsupported file type — PDF, DOC or DOCX only'), { status: 400 }));
  },
});

// Stores the raw buffer under a random object name and returns the GCS
// object path (not a URL) — the bucket is private, so nothing is servable
// without a freshly-generated signed URL (see signedResumeUrl).
export async function saveResume(file) {
  if (!file) return null;
  const ext = file.originalname?.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || 'bin';
  const objectName = `resumes/${Date.now()}-${randomUUID()}.${ext}`;
  await bucket.file(objectName).save(file.buffer, {
    contentType: file.mimetype,
    resumable: false, // single small upload, no need for resumable session overhead
  });
  return objectName;
}

// Generated fresh on every admin read (see jobApplicationService.listJobApplications)
// rather than stored, so links never go stale — a resume submitted months ago
// is just as viewable as one from today.
export async function signedResumeUrl(objectPath) {
  if (!objectPath) return null;
  const [url] = await bucket.file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 30 * 60 * 1000, // 30 min
  });
  return url;
}
