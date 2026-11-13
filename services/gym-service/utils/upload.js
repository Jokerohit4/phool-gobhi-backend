import multer from 'multer';
import cloudinary from '../config/cloudinary.js';

export const hasCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const fileFilterImage = (req, file, cb) => {
  if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Invalid file type. Only JPG, PNG, and WebP images are allowed.'));
};

const fileFilterDoc = (req, file, cb) => {
  if (ALLOWED_DOC_MIME.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Invalid file type. Only PDF and images (JPG, PNG, WebP) are allowed.'));
};

export const uploadGymImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilterImage,
});
export const uploadGymDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilterDoc,
});

// Cloudinary intermittently rejects an otherwise-valid, correctly-signed
// request with a misleading 401 "Unknown API key" — observed repeatedly in
// prod (gym photo uploads), root cause undetermined (ruled out: wrong/
// rotated credentials, a stale keep-alive connection, request size — direct
// calls with the exact same key/secret never fail). Failures come in short
// clusters with clean stretches between them, not a persistent block, so a
// few retries with backoff absorbs it without needing a static egress IP
// (ruled out on cost).
export async function uploadBufferToCloudinary(buffer, options, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
        stream.end(buffer);
      });
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// The retry above only helps when the failure is transient — it isn't when
// gym-service's own outbound path to Cloudinary is the thing rejecting the
// request (confirmed live: a direct call with the same key from outside
// Cloud Run succeeds at the exact moment gym-service's calls fail 100% of
// the time, retries included). A static egress IP would be the durable
// backend-side fix but costs money we don't have right now, so instead the
// browser uploads straight to Cloudinary itself — gym-service never touches
// the file, it only hands out a short-lived signature for the upload the
// browser is about to make, using its own IP instead of Cloud Run's.
export function signCloudinaryUpload({ folder, resourceType }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = { folder, timestamp };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
    resourceType,
  };
}

// Cloudinary's stored secure_url is the untransformed original — this
// inserts the same resize/quality transform addGymImage used to apply
// upload-time (via multer-storage-cloudinary's `params.transformation`) as
// a delivery-time transform instead, so a browser-uploaded photo looks
// identical to a server-uploaded one wherever it's later displayed.
export function withGymImageTransform(secureUrl) {
  return secureUrl.replace('/upload/', '/upload/w_1200,h_800,c_limit,q_auto/');
}
