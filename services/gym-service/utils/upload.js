import multer from 'multer';
import cloudinary from '../config/cloudinary.js';

const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let imageStorage;
let docStorage;
if (hasCloudinary) {
  const { CloudinaryStorage } = await import('multer-storage-cloudinary');
  imageStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'phool-gobhi/gyms',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }],
    },
  });
  // Brand/verification documents: allow PDFs alongside images and skip the
  // image transformation. resource_type 'auto' lets Cloudinary store PDFs (raw)
  // and images under the same uploader.
  docStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'phool-gobhi/docs',
      resource_type: 'auto',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
    },
  });
} else {
  imageStorage = multer.memoryStorage();
  docStorage = multer.memoryStorage();
}

export const uploadGymImage = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap, same as documents below
});
export const uploadGymDoc = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap for documents
});
