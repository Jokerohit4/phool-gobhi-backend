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
