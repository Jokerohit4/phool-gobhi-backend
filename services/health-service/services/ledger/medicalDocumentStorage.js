import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'crypto';

// Private storage for medical records.
//
// GCS, not Cloudinary, for the same reason auth-service uses it for resumes:
// Cloudinary refuses authenticated delivery of PDFs. That constraint does not
// apply here, but neither does a reason to reach for a different vendor — one
// storage client, one set of credentials, one place to audit.
//
// Three properties this module is responsible for, and none of them are
// negotiable for this bucket:
//
//   1. NOTHING IS PUBLICLY SERVABLE. There is no public ACL, no website
//      config, and no signed-URL persistence. Every read mints a fresh
//      short-lived URL. A prescription is not a gym photo: the blast radius of
//      a leaked link is a different category of harm.
//
//   2. NO IMAGE IS EVER INTERPRETED. This module can store a JPEG and hand back
//      a link. It has no OCR, no vision, no text extraction, and the
//      service layer that calls it must not add one. "Upload your blood work"
//      means the user can attach it and re-open it, not that the app reads it.
//      That line is what keeps the feature in general-wellness territory.
//
//   3. THE OBJECT NAME CARRIES NO USER DATA. `medical/{userId}/{uuid}.{ext}`
//      — a random name, never the original filename. Prescription filenames are
//      frequently "DrSharma- diabetes-final-v2.pdf", and a filename in an
//      object key ends up in bucket listings, logs and audit trails.

const BUCKET_NAME = process.env.MEDICAL_BUCKET_NAME || 'phool-gobhi-medical';

      // Constructed lazily. This module is imported by ledgerConsentService.js at
// scope for the revocation path, and health-service boots in environments
// (CI, local, a developer's laptop) that have no GCP credentials at all. A
// missing credential must not take down consent revocation for every user, so
// the client is built on first use and its failure is caught where it happens
// rather than at import.
let bucket = null;
function getBucket() {
  if (!bucket) bucket = new Storage().bucket(BUCKET_NAME);
  return bucket;
}

// The app serves images and PDFs for gym photos and brand docs. A medical
// record is a different class of file: an image could be a photo of a
// prescription, and PDFs are a known vector. Both are accepted, but nothing
// executable and nothing from an image format with scripting history.
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
]);

const EXT_BY_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
};

// 10 MB. A phone photo of a lab report is comfortably inside this; anything
// larger is not a record anyone needs to read on a phone.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function isAllowedMimeType(mimeType) {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

/**
 * Whether this module may store a file as a health-vault lab report.
 *
 * Stricter than isAllowedMimeType, and the difference is the OCR step: only a
 * PDF reaches Document AI. A JPEG of a lab report is a real thing people have,
 * and rejecting it is the honest answer for now, because the alternative is
 * uploading it, labelling a JPEG as application/pdf, and reporting a parsing
 * failure for a file that was perfectly readable to a human.
 *
 * Images remain accepted by isAllowedMimeType for the medical-document path,
 * where nothing reads them and a photo of a prescription is a normal upload.
 */
export function isAllowedReportMimeType(mimeType) {
  return mimeType === 'application/pdf';
}

function extensionFor(mimeType) {
  return EXT_BY_MIME[mimeType] || 'bin';
}

/**
 * Stores a buffer and returns the GCS object path.
 *
 * Returns the PATH, not a URL, exactly like auth-service's saveResume. The
 * bucket has no public access, so a stored path is inert on its own and the
 * only way to read a record is signedDocumentUrl.
 */
export async function saveDocument({ buffer, mimeType, userId }) {
  if (!buffer || !buffer.length) return null;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw Object.assign(new Error('Unsupported file type'), { status: 400 });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('File is larger than 10 MB'), { status: 400 });
  }

  // userId is a path segment, not a filename. It is an internal integer, and it
  // is what makes a per-user listing possible without a database query.
  const objectName = `medical/${userId}/${randomUUID()}.${extensionFor(mimeType)}`;

  await getBucket().file(objectName).save(buffer, {
    contentType: mimeType,
    // The bucket is private at the IAM level too, not only by ACL — a
    // misconfigured ACL on an object cannot make this readable.
    resumable: false,
    metadata: {
      cacheControl: 'private, no-store',
      // Tells GCS not to try to sniff or transform anything.
      contentDisposition: 'attachment',
    },
  });

  return objectName;
}

/**
 * Mints a fresh signed read URL, valid for 5 minutes.
 *
 * Shorter than auth-service's 30 minutes on purpose: a prescription link that
 * sits in a screenshot or a chat for half an hour is a longer exposure than
 * this content warrants. Minted per read and never persisted, so revoking
 * consent (consentService.revokeMedicalRecordsConsent) has nothing to walk —
 * the URLs already in the wild simply expire.
 */
export async function signedDocumentUrl(objectPath) {
  if (!objectPath) return null;

  const [url] = await getBucket().file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 5 * 60 * 1000,
  });
  return url;
}

/**
 * Deletes objects by path. Tolerates a missing bucket or object.
 *
 * This is called from consent revocation, where the row deletion has already
 * committed and the user has already lost access in the app. Failing the
 * revocation because GCS was unreachable would leave a record that is invisible
 * in the product but still present in a bucket — the exact orphan state a
 * deletion promise is supposed to prevent. So a storage failure is logged and
 * swallowed, and the orphaned object is a known, logged, recoverable condition
 * rather than a failed deletion.
 *
 * Returns the paths that could not be deleted so the caller can surface it.
 */
export async function deleteObjects(objectPaths) {
  const paths = (objectPaths || []).filter(Boolean);
  const failed = [];
  if (!paths.length) return { deleted: 0, failed };

  try {
    await Promise.all(
      paths.map(async (p) => {
        try {
          await getBucket().file(p).delete({ ignoreNotFound: true });
        } catch (err) {
          failed.push(p);
          console.error('[medicalStorage] failed to delete object', p, err?.message);
        }
      }),
    );
  } catch (err) {
    // getBucket() itself failed — no credentials, no such bucket.
    console.error('[medicalStorage] bucket unavailable, objects orphaned', err?.message);
    return { deleted: 0, failed: paths };
  }

  return { deleted: paths.length - failed.length, failed };
}

/**
 * Deletes EVERYTHING under a user's `medical/{userId}/` prefix, in one request.
 *
 * Exists because deleteObjects works from a list of paths read out of the
 * database, and that list is only complete while the rows still exist. Account
 * deletion removes the rows first — deliberately, because a GCS outage must
 * not roll back the erasure — which means by the time anyone wants to sweep the
 * blobs, the record of what they were called is gone.
 *
 * The prefix layout is what makes this recoverable: every object is written
 * under `medical/{userId}/`, so a single list-and-delete reclaims anything a
 * partial failure left behind, with no database row needed. The userId segment
 * is an internal integer, and the filename is a random uuid, so the prefix
 * itself carries nothing identifying to leak in a log line.
 *
 * Best-effort and never throws, for the same reason deleteObjects does not:
 * this is a backstop, not the primary deletion.
 */
export async function deleteUserObjects(userId) {
  if (userId == null) return { deleted: 0, failed: [] };

  const prefix = `medical/${userId}/`;
  const failed = [];
  let deleted = 0;

  try {
    const bucket = getBucket();
    const [files] = await bucket.getFiles({ prefix });

    for (const file of files) {
      try {
        await file.delete({ ignoreNotFound: true });
        deleted += 1;
      } catch (err) {
        failed.push(file.name);
        console.error('[medicalStorage] failed to sweep object', file.name, err?.message);
      }
    }

    if (files.length > 0) {
      console.log(
        `[medicalStorage] swept ${deleted} orphaned object(s) under ${prefix}` +
          (failed.length ? `, ${failed.length} still failing` : ''),
      );
    }
  } catch (err) {
    console.error('[medicalStorage] prefix sweep unavailable', err?.message);
    return { deleted, failed: ['<prefix-sweep-unavailable>'] };
  }

  return { deleted, failed };
}
