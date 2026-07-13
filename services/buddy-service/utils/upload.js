import multer from 'multer';
import cloudinary from '../config/cloudinary.js';

const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let photoStorage;
if (hasCloudinary) {
  const { CloudinaryStorage } = await import('multer-storage-cloudinary');
  photoStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'phool-gobhi/buddy-profiles',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      // Portrait-friendly crop for dating-style profile cards, similar to
      // gym-service's 'limit' approach so we never upscale a smaller source.
      transformation: [{ width: 1080, height: 1350, crop: 'limit', quality: 'auto' }],
    },
  });
} else {
  photoStorage = multer.memoryStorage();
}

export const MAX_BUDDY_PHOTOS = 6;

export const uploadBuddyPhotos = multer({
  storage: photoStorage,
  limits: { fileSize: 8 * 1024 * 1024, files: MAX_BUDDY_PHOTOS }, // 8 MB per photo
});
