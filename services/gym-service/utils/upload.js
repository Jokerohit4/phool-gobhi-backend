import multer from 'multer';
import cloudinary from '../config/cloudinary.js';

export const hasCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

// Buffers in memory instead of streaming straight to Cloudinary (as
// multer-storage-cloudinary did) so a failed Cloudinary call can be retried
// against the same buffer — see uploadBufferToCloudinary below.
export const uploadGymImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap, same as documents below
});
export const uploadGymDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap for documents
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
