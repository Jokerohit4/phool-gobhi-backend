import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'crypto';

// Private storage for food photos.
//
// Its own module and its own bucket, NOT a reuse of medicalDocumentStorage, and
// the difference is the whole point. That module's second documented invariant
// is "no image is ever interpreted" - which is exactly the property that makes a
// prescription a prescription. A food photo is the opposite case: the image is
// sent to a vision model on purpose, and that is the feature. Reusing the
// module would mean either weakening an invariant written for a different
// content class, or quietly violating it, and both are worse than a second file.
//
// What is deliberately NOT relaxed, because it has nothing to do with the model:
//
//   1. STILL PRIVATE. No public ACL, no public website config, no persisted
//      signed URL. Every read mints a fresh short-lived link.
//
//   2. THE OBJECT NAME STILL CARRIES NO USER DATA. `food/{userId}/{uuid}.{ext}`.
//      A camera's default filename is often a date, and in the worst case an
//      iPhone's is a location - "IMG_4821.HEIC" is fine, but a name that a user
//      renamed to "before-and-after-july" is not, and object keys end up in
//      bucket listings, logs and audit trails.
//
//   3. IMAGES ONLY. No PDF, no HEIC with a scripting history. A photo comes
//      from a camera roll, never from a file manager picking an arbitrary
//      document, so the allowlist is narrower than the medical one rather than
//      wider.
//
// What IS different, deliberately:
//
//   - The photo is kept, not thrown away. The user asked to see what they ate
//     later, so a confirmed log keeps its picture. That makes deletion a real
//     obligation rather than a courtesy, which is why sweepUnconfirmedPhotos
//     and deleteUserPhotos both exist below and erasureCompleteness.test.js
//     covers the account-level one.
//
// Food photos are not medical records, but they are not nothing either: a
// consistent diet is often religion (no beef, no pork), and often a health
// signal the user has not told anyone. Treat a leaked bucket accordingly.

const BUCKET_NAME = process.env.FOOD_PHOTO_BUCKET_NAME || 'phool-gobhi-food-photos';

// Constructed lazily for the same reason as the medical bucket: this module is
// imported at scope by the recognise path, and health-service boots in CI, on a
// laptop, and in environments with no GCP credentials at all. A missing
// credential must not break the import.
let bucket = null;
function getBucket() {
  if (!bucket) bucket = new Storage().bucket(BUCKET_NAME);
  return bucket;
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

// 8 MB. A modern phone camera is 2-6 MB, and the image is sent inline to the
// vision provider on every request - so this is also a latency and a cost bound,
// not only a disk bound. Anything larger is a gallery screenshot or a
// mis-selected file rather than a photo of a plate.
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export function isAllowedMimeType(mimeType) {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

function extensionFor(mimeType) {
  return EXT_BY_MIME[mimeType] || 'jpg';
}

export async function savePhoto({ buffer, mimeType, userId }) {
  if (!buffer || !buffer.length) return null;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw Object.assign(new Error('That image type is not accepted'), { status: 400 });
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw Object.assign(new Error('That photo is larger than 8 MB'), { status: 400 });
  }

  const objectName = `food/${userId}/${randomUUID()}.${extensionFor(mimeType)}`;

  await getBucket().file(objectName).save(buffer, {
    contentType: mimeType,
    resumable: false,
    metadata: { cacheControl: 'private, no-store' },
  });

  return objectName;
}

/**
 * Mints a fresh signed read URL, valid for 5 minutes.
 *
 * Same lifetime as a prescription link, and for the same reason: a five-minute
 * link that ends up in a screenshot expires before the screenshot stops being a
 * way to see someone's diet.
 */
export async function signedPhotoUrl(objectPath) {
  if (!objectPath) return null;
  const [url] = await getBucket().file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 5 * 60 * 1000,
  });
  return url;
}

/**
 * Best-effort delete by path, for a log or a request that is being withdrawn.
 *
 * Never throws. Mirrors the medical module's reasoning: the database row is
 * already gone by the time this runs, and failing the user's request because
 * GCS was unreachable would leave a picture that the product can no longer
 * reference but that still exists in a bucket.
 */
export async function deletePhotos(objectPaths) {
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
          console.error('[foodPhotoStorage] failed to delete object', p, err?.message);
        }
      }),
    );
  } catch (err) {
    console.error('[foodPhotoStorage] bucket unavailable, objects orphaned', err?.message);
    return { deleted: 0, failed: paths };
  }

  return { deleted: paths.length - failed.length, failed };
}

/**
 * Reclaims photos that were recognised but never confirmed.
 *
 * A photo is stored at recognise time, because the image has to exist before the
 * model can read it and the client should not have to upload it twice. If the
 * user then backs out of the confirm screen - which most of the time means the
 * model guessed wrong and they did not want to correct it - nothing references
 * that object and it would sit in the bucket forever.
 *
 * So: any path recorded on a FoodPhotoRequestLog that no FoodLog points at, and
 * that is older than the TTL, is deleted and the request row is stamped
 * `abandonedAt`. Stamping rather than deleting the row is deliberate - the
 * request already cost money whatever the user did next, so the row is the only
 * record of that spend.
 *
 * The age check is what keeps this from racing a confirm in progress. A photo
 * sitting in a review screen for under the TTL is not garbage.
 *
 * `olderThanHours` is a parameter rather than a constant because the value is a
 * judgement about how long a review session can plausibly last, and that is not
 * something this file gets to decide on its own.
 *
 * `deleteFn` exists so the decision logic above can be tested without a bucket.
 * It defaults to this module's own deletePhotos and has no other caller.
 */
export async function sweepUnconfirmedPhotos(
  prisma,
  { olderThanHours = 24, now = new Date(), deleteFn = deletePhotos } = {},
) {
  const cutoff = new Date(now.getTime() - olderThanHours * 60 * 60 * 1000);

  const stale = await prisma.foodPhotoRequestLog.findMany({
    where: { photoPath: { not: null }, abandonedAt: null, requestedAt: { lt: cutoff } },
    select: { id: true, photoPath: true },
  });
  if (!stale.length) return { swept: 0, failed: [] };

  // A path is kept if ANY log still points at it. Two requests can resolve to
  // the same object only if a client re-sent one, but a path can also appear on
  // two request rows - the first attempt failed after the upload and the second
  // reused it - and deleting an object a live log still references would break a
  // photo the user can currently see.
  const stillReferenced = await prisma.foodLog.findMany({
    where: { photoPath: { in: stale.map((r) => r.photoPath) } },
    select: { photoPath: true },
  });
  const live = new Set(stillReferenced.map((r) => r.photoPath));

  const doomed = stale.filter((r) => !live.has(r.photoPath));
  if (!doomed.length) return { swept: 0, failed: [] };

  const { failed } = await deleteFn(doomed.map((r) => r.photoPath));

  const failedSet = new Set(failed);
  await prisma.foodPhotoRequestLog.updateMany({
    where: { id: { in: doomed.filter((r) => !failedSet.has(r.photoPath)).map((r) => r.id) } },
    data: { abandonedAt: now },
  });

  const swept = doomed.length - failed.length;
  if (swept > 0 || failed.length > 0) {
    console.log(`[foodPhotoStorage] swept ${swept} unconfirmed photo(s), ${failed.length} still failing`);
  }
  return { swept, failed };
}

/**
 * Deletes EVERYTHING under a user's `food/{userId}/` prefix, in one request.
 *
 * The account-erasure backstop, and the reason the prefix layout is fixed. Row
 * deletion happens first - a GCS outage must not roll back an erasure - so by
 * the time anyone sweeps the blobs, the database no longer remembers what they
 * were called. A single prefix list reclaims them with no row needed.
 *
 * Best-effort and never throws, for the same reason deletePhotos does not.
 */
export async function deleteUserPhotos(userId) {
  if (userId == null) return { deleted: 0, failed: [] };
  const prefix = `food/${userId}/`;
  const failed = [];
  let deleted = 0;

  try {
    const b = getBucket();
    const [files] = await b.getFiles({ prefix });
    for (const file of files) {
      try {
        await file.delete({ ignoreNotFound: true });
        deleted += 1;
      } catch (err) {
        failed.push(file.name);
        console.error('[foodPhotoStorage] failed to sweep object', file.name, err?.message);
      }
    }
    if (files.length > 0) {
      console.log(
        `[foodPhotoStorage] swept ${deleted} orphaned photo(s) under ${prefix}` +
          (failed.length ? `, ${failed.length} still failing` : ''),
      );
    }
  } catch (err) {
    console.error('[foodPhotoStorage] prefix sweep unavailable', err?.message);
    return { deleted, failed: ['<prefix-sweep-unavailable>'] };
  }

  return { deleted, failed };
}
