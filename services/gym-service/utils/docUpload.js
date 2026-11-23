import cloudinary from '../config/cloudinary.js';

// Browser-direct upload of brand/verification documents. Storage and delivery
// are IDENTICAL to the multipart POST /:id/docs path: Cloudinary
// resource_type 'auto' (so PDFs/images land as resource_type 'image'),
// delivery type 'upload', and the stored value is the asset's secure_url in
// Gym.brandDocs[]. The only difference is the folder is scoped per gym
// (phool-gobhi/docs/<gymId>) so a registered public_id can be bound to the
// gym that owns it.
export const DOC_MAX_BYTES = 10 * 1024 * 1024;
export const DOC_ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
const DOC_ROOT_FOLDER = 'phool-gobhi/docs';

// A document URL we are willing to persist from a client-supplied value (the
// legacy JSON {url} variant of POST /:id/docs, brandDocs on gym create/update,
// and doc_add edit requests). Admins open these as plain links, so anything
// other than an asset on OUR Cloudinary cloud is refused: https only, host
// res.cloudinary.com, first path segment = the configured cloud name, no
// credentials, port, query or fragment, bounded length, no dot segments.
export const DOC_URL_MAX_LENGTH = 500;

export function isTrustedDocUrl(value, cloudName = process.env.CLOUDINARY_CLOUD_NAME) {
  if (typeof value !== 'string' || value.length === 0 || value.length > DOC_URL_MAX_LENGTH) return false;
  if (typeof cloudName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cloudName)) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com') return false;
  if (u.username || u.password || u.port || u.search || u.hash) return false;
  if (!u.pathname.startsWith('/' + cloudName + '/') || u.pathname.length === cloudName.length + 2) return false;
  if (u.pathname.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  if (/%2e|%2f|%5c/i.test(u.pathname)) return false;
  return true;
}

export function docFolderForGym(gymId) {
  return `${DOC_ROOT_FOLDER}/${gymId}`;
}

// Cloudinary's auto-generated public ids are a single [A-Za-z0-9_-] segment
// under the signed folder. Anything else (extra slashes, dots, another gym's
// folder, the legacy shared folder) is refused.
export function isPublicIdInGymFolder(publicId, gymId) {
  if (typeof publicId !== 'string' || publicId.length > 255) return false;
  const prefix = `${docFolderForGym(gymId)}/`;
  return publicId.startsWith(prefix) && /^[A-Za-z0-9_-]{1,128}$/.test(publicId.slice(prefix.length));
}

export function signDocUpload(gymId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = docFolderForGym(gymId);
  const allowedFormats = DOC_ALLOWED_FORMATS.join(',');
  // Every signed param must be sent verbatim by the browser; Cloudinary then
  // enforces folder and allowed_formats server-side.
  const paramsToSign = { allowed_formats: allowedFormats, folder, timestamp };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
    allowedFormats,
    resourceType: 'auto',
    type: 'upload',
    maxBytes: DOC_MAX_BYTES,
  };
}

// Ask Cloudinary (Admin API) what actually got stored, so the persisted URL,
// size and format come from Cloudinary and never from the browser.
export async function fetchUploadedDoc(publicId) {
  return cloudinary.api.resource(publicId, { resource_type: 'image', type: 'upload' });
}

export async function discardUploadedDoc(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch {
    // best effort only
  }
}
